/**
 * CAMPAIGN → SITE → VENTURE, AND EXACTLY WHAT KIND OF JOIN EACH ARROW IS.
 *
 * THE THREE JOINS, NAMED, BECAUSE THEY ARE NOT THE SAME STRENGTH AND A
 * DOCUMENT THAT TREATED THEM AS ONE WOULD BE THE LIE THIS FILE EXISTS TO
 * AVOID:
 *
 *   1. CAMPAIGN → VENTURE IS BY ID, AND BY A DECISION. `campaign_ventures`
 *      holds a row per campaign id that somebody wrote. The suggestions below
 *      are computed fresh on every read out of live rows and carry the
 *      sentence that produced them; nothing is stored without a press. That is
 *      `ventures/links.ts`'s contract and it is here for its reason: a
 *      hostname match is evidence, not a decision, and a box that filed one
 *      business's campaign under another automatically would be wrong in a way
 *      nobody notices until a spend figure is captioned with the wrong name.
 *
 *   2. SPEND AND CLICKS COME FROM THE CAMPAIGN ID. `ad_days` and
 *      `meta_ad_days` are keyed by ids Meta issued; summing them over a
 *      venture's mapped campaigns is exact arithmetic on an exact join.
 *
 *   3. SITE TRAFFIC IS JOINED BY NAME, AND IT IS A STRING MATCH. Umami has
 *      never heard of a Meta campaign id. What the site sees is whatever text
 *      was typed into `utm_campaign` when the link was built, so the join is
 *      the campaign's NAME (or a name the owner mapped) against that text,
 *      lowercased. It is as good as the tagging was. A campaign whose links
 *      were never tagged shows spend and no tagged views, and that is a fact
 *      about the tagging, NOT a measurement that the campaign sent nobody.
 *
 * AND THE FOURTH THING, WHICH IS NOT A JOIN AT ALL. Revenue is VENTURE-LEVEL:
 * it is every euro that business took, from Stripe, the stores and AdSense,
 * over a calendar month. It is not attributed to a campaign, to a click or to
 * a session by anything. Dividing it by ad spend produces a BLENDED EFFICIENCY
 * ratio — how much the business earned per unit it spent on advertising — and
 * that is a different number from return on ad spend, which requires
 * attribution this box does not have and Meta does not report for these
 * accounts. Every document says "blended" beside it, and the two windows do
 * not even line up: the ad window is complete days and the revenue is a
 * calendar month, which is stated rather than smoothed over.
 */
import { db, metaCampaigns, ventureRows, type VentureRow } from "../../db.ts";
import { adDaysSince, campaignVentures, utmOf, type UtmRow } from "./store.ts";
import { adCreatives, adSets } from "./store.ts";
import { conversionEvents, revenueSources, unitFor } from "./settings.ts";
import { isoDay, dayStart } from "../analytics/umami.ts";

/* ------------------------------------------------------------------ hosts */

/** A hostname out of anything host-shaped, `www.` removed so `www.x.com` and
 *  `x.com` are one business. */
export function host(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = String(raw).trim().toLowerCase();
  if (!v) return null;
  if (v.includes("://")) {
    try {
      v = new URL(v).hostname;
    } catch {
      return null;
    }
  } else {
    v = v.split("/")[0]!.split("?")[0]!;
  }
  v = v.replace(/^www\./, "").replace(/:\d+$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(v) ? v : null;
}

/**
 * Every hostname mentioned in a piece of text.
 *
 * Meta names campaigns and ad sets after what they promote — the live account
 * carries `Promoting https://example-app-4.example.test/become-a-tutor/apply` and
 * `Promoting website: https://api.whatsapp.com/send` — so the destination is
 * very often sitting in the name as text. Both full URLs and bare hostnames
 * are found, because both forms appear.
 */
export function hostsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of String(text).matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)) {
    const h = host(m[0]);
    if (h) out.add(h);
  }
  for (const m of String(text).matchAll(/\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})\b/gi)) {
    const h = host(m[1]);
    if (h) out.add(h);
  }
  return [...out];
}

/** The hostnames one venture answers to: its own `host` column and the host
 *  of its website, which are usually but not always the same. */
export function ventureHosts(v: VentureRow): string[] {
  return [...new Set([host(v.host), host(v.website)].filter((h): h is string => Boolean(h)))];
}

/* ------------------------------------------------------------ suggestions */

export type CampaignSuggestion = {
  platform: "meta";
  campaignId: string;
  campaignName: string | null;
  adAccountId: string;
  ventureId: string;
  ventureName: string;
  /** The sentence that produced it. Kept with the row when it is accepted. */
  evidence: string;
  /** Which source matched — a link somewhere in the campaign, or a UTM tag the
   *  site actually saw. Both are `auto-by-link` when accepted; this says which
   *  kind of link it was. */
  via: "campaign-name" | "adset-name" | "ad-name" | "creative-link" | "utm-tag";
};

/**
 * Every campaign this box could file, with the sentence that would file it.
 *
 * RECOMPUTED PER REQUEST, `ventures/links.ts`'s decision and for its reason: a
 * cached suggestion is a suggestion about a campaign that may have been
 * renamed this morning, and the whole point of the list is that it reflects
 * what the collectors currently hold.
 *
 * A CAMPAIGN ALREADY MAPPED IS NOT SUGGESTED. A campaign that matches two
 * ventures produces two suggestions and neither is applied; the owner picks,
 * which is exactly the case a machine must not decide.
 */
export function suggestions(): CampaignSuggestion[] {
  const mapped = new Set(campaignVentures().map((r) => `${r.platform} ${r.campaign_id}`));
  const ventures = ventureRows();
  const byHost = new Map<string, VentureRow>();
  for (const v of ventures) for (const h of ventureHosts(v)) if (!byHost.has(h)) byHost.set(h, v);

  const sets = adSets();
  const ads = adCreatives();
  const setsByCampaign = new Map<string, typeof sets>();
  for (const s of sets)
    if (s.campaign_id) setsByCampaign.set(s.campaign_id, [...(setsByCampaign.get(s.campaign_id) ?? []), s]);
  const adsByCampaign = new Map<string, typeof ads>();
  for (const a of ads)
    if (a.campaign_id) adsByCampaign.set(a.campaign_id, [...(adsByCampaign.get(a.campaign_id) ?? []), a]);

  /* The utm_campaign values each venture's own sites actually saw, which is
     the second, independent kind of evidence: not "this campaign mentions that
     host" but "that site was visited with this campaign's name on the link". */
  const tagsByVenture = new Map<string, Set<string>>();
  for (const v of ventures) {
    const sites = linkedUmamiSites(v.id);
    if (!sites.length) continue;
    const tags = new Set<string>();
    for (const row of utmOf(sites, 30, 0)) if (row.utm_campaign) tags.add(row.utm_campaign);
    if (tags.size) tagsByVenture.set(v.id, tags);
  }

  const out: CampaignSuggestion[] = [];
  for (const campaign of metaCampaigns()) {
    if (mapped.has(`meta ${campaign.campaign_id}`)) continue;
    const seen = new Set<string>();
    const propose = (v: VentureRow, via: CampaignSuggestion["via"], evidence: string) => {
      if (seen.has(v.id)) return;
      seen.add(v.id);
      out.push({
        platform: "meta",
        campaignId: campaign.campaign_id,
        campaignName: campaign.name,
        adAccountId: campaign.ad_account_id,
        ventureId: v.id,
        ventureName: v.name,
        evidence,
        via,
      });
    };

    for (const h of hostsIn(campaign.name)) {
      const v = byHost.get(h);
      if (v) propose(v, "campaign-name", `The campaign's own name mentions ${h}, which is ${v.name}'s host.`);
    }
    for (const s of setsByCampaign.get(campaign.campaign_id) ?? [])
      for (const h of hostsIn(s.name)) {
        const v = byHost.get(h);
        if (v)
          propose(v, "adset-name", `Its ad set “${s.name}” mentions ${h}, which is ${v.name}'s host.`);
      }
    for (const a of adsByCampaign.get(campaign.campaign_id) ?? []) {
      const linked = host(a.link_url);
      const v = linked ? byHost.get(linked) : undefined;
      if (v)
        propose(
          v,
          "creative-link",
          `Its advertisement “${a.name}” sends people to ${linked}, which is ${v.name}'s host.`,
        );
      for (const h of hostsIn(a.name)) {
        const w = byHost.get(h);
        if (w) propose(w, "ad-name", `Its advertisement “${a.name}” mentions ${h}, which is ${w.name}'s host.`);
      }
    }

    const name = (campaign.name ?? "").trim().toLowerCase();
    if (name)
      for (const [ventureId, tags] of tagsByVenture)
        if (tags.has(name)) {
          const v = ventures.find((x) => x.id === ventureId);
          if (v)
            propose(
              v,
              "utm-tag",
              `${v.name}'s site was visited with utm_campaign=${name} in the last 30 days, which is this campaign's name. A NAME match, not an id match.`,
            );
        }
  }
  return out;
}

/** The Umami website ids one venture is linked to, from `venture_links`. */
export function linkedUmamiSites(ventureId: string): string[] {
  return (
    db
      .prepare("SELECT entity FROM venture_links WHERE venture_id = ? AND plugin = 'umami' ORDER BY entity")
      .all(ventureId) as { entity: string }[]
  ).map((r) => r.entity);
}

/* --------------------------------------------------------------- the join */

export type VentureJoin = {
  venture: { id: string; slug: string; name: string; stage: string };
  windowDays: number;
  startDay: string;
  endDay: string;
  /** Campaigns filed to this venture, and how each was filed. */
  campaigns: {
    campaignId: string;
    name: string | null;
    adAccountId: string;
    currency: string | null;
    source: string;
    evidence: string | null;
    spend: number | null;
    impressions: number | null;
    clicks: number | null;
    /** Days of the window with a row. A campaign that stopped delivering has
     *  fewer, and Meta reports no row for a day nothing was spent. */
    days: number;
  }[];
  /** Per currency, because two ad accounts may bill in two and this box
   *  fetches no exchange rate. */
  spend: { currency: string; amount: number }[];
  clicks: number | null;
  impressions: number | null;
  /** Tagged views on this venture's own sites, joined BY NAME. */
  tagged: {
    campaign: string;
    source: string | null;
    medium: string | null;
    views: number;
    /** Whether a mapped Meta campaign carries this name. */
    matchedCampaignId: string | null;
  }[];
  taggedViews: number | null;
  /** Conversions, from the per-venture setting. Participants, not
   *  occurrences — and participants are session identities. */
  conversions: {
    event: string;
    participants: number | null;
    occurrences: number | null;
    websiteId: string;
  }[];
  /** Every reason a figure above is null or missing. */
  notes: string[];
};

const sum = (rows: (number | null)[]): number | null => {
  const seen = rows.filter((v): v is number => v !== null);
  return seen.length ? Math.round(seen.reduce((a, b) => a + b, 0) * 1e6) / 1e6 : null;
};

/**
 * One venture's joined performance.
 *
 * WHAT IS NOT HERE AND WILL NOT BE: reach, frequency, and any per-campaign
 * conversion rate. Reach and frequency are de-duplicated per row and summing
 * them across a venture's campaigns would count the same person once per
 * campaign; a conversion rate would divide site events by ad clicks, which are
 * two populations measured by two systems that have never met.
 */
export function joinFor(venture: VentureRow, windowDays: number): VentureJoin {
  const startDay = isoDay(dayStart(windowDays));
  const endDay = isoDay(dayStart(1));
  const notes: string[] = [];

  const mapped = campaignVentures().filter((r) => r.venture_id === venture.id);
  const campaignRows = new Map(metaCampaigns().map((c) => [c.campaign_id, c]));
  const accountCurrency = new Map(
    (db.prepare("SELECT ad_account_id, currency FROM meta_ad_accounts").all() as {
      ad_account_id: string;
      currency: string | null;
    }[]).map((r) => [r.ad_account_id, r.currency]),
  );

  const days = adDaysSince(startDay);
  const byCampaign = new Map<string, typeof days>();
  for (const d of days)
    if (d.campaign_id) byCampaign.set(d.campaign_id, [...(byCampaign.get(d.campaign_id) ?? []), d]);

  const campaigns: VentureJoin["campaigns"] = [];
  const spendByCurrency = new Map<string, number>();
  for (const m of mapped) {
    const meta = campaignRows.get(m.campaign_id);
    const adAccountId = meta?.ad_account_id ?? "";
    const currency = accountCurrency.get(adAccountId) ?? null;
    const rows = (byCampaign.get(m.campaign_id) ?? []).filter((d) => d.day >= startDay);
    const spend = sum(rows.map((r) => r.spend));
    campaigns.push({
      campaignId: m.campaign_id,
      name: meta?.name ?? null,
      adAccountId,
      currency,
      source: m.source,
      evidence: m.evidence,
      spend,
      impressions: sum(rows.map((r) => r.impressions)),
      clicks: sum(rows.map((r) => r.clicks)),
      days: new Set(rows.map((r) => r.day)).size,
    });
    if (spend !== null && currency)
      spendByCurrency.set(currency, (spendByCurrency.get(currency) ?? 0) + spend);
    if (spend !== null && !currency)
      notes.push(
        `Campaign ${m.campaign_id} has spend and no currency on its ad account row, so it is left out of the per-currency total.`,
      );
    if (!meta)
      notes.push(
        `Campaign ${m.campaign_id} is mapped to this venture and is not in meta_campaigns — it was deleted at Meta, or is past the campaign edge's page cut.`,
      );
  }

  /* ---- what the sites saw, joined BY NAME ---- */
  const sites = linkedUmamiSites(venture.id);
  let tagged: VentureJoin["tagged"] = [];
  let taggedViews: number | null = null;
  if (!sites.length)
    notes.push(
      "No Umami website is linked to this venture, so there is no site traffic to join. Link one on the venture's map.",
    );
  else {
    const utmWindow = windowDays <= 7 ? 7 : 30;
    if (utmWindow !== windowDays)
      notes.push(
        `UTM rows are collected over 7 and 30 complete days only; the ${utmWindow}-day window is used for the tagged views while the spend above covers ${windowDays}. The two are NOT the same span.`,
      );
    const rows: UtmRow[] = utmOf(sites, utmWindow, 0);
    const nameToId = new Map<string, string>();
    for (const c of campaigns) if (c.name) nameToId.set(c.name.trim().toLowerCase(), c.campaignId);
    const bucket = new Map<string, VentureJoin["tagged"][number]>();
    for (const r of rows) {
      if (!r.utm_campaign) continue;
      const k = `${r.utm_campaign}|${r.utm_source}|${r.utm_medium}`;
      const at = bucket.get(k);
      if (at) at.views += r.views;
      else
        bucket.set(k, {
          campaign: r.utm_campaign,
          source: r.utm_source || null,
          medium: r.utm_medium || null,
          views: r.views,
          matchedCampaignId: nameToId.get(r.utm_campaign) ?? null,
        });
    }
    tagged = [...bucket.values()].sort((a, b) => b.views - a.views);
    /*
      NULL IS "NOT MEASURED", ZERO IS "MEASURED AS NONE", AND THE DIFFERENCE IS
      WHETHER THIS SITE HAS EVER BEEN READ.

      The collector rotates a few websites a pass on a twelve-hour clock, so a
      venture whose site has not had its turn has no `web_utm` rows at all —
      and publishing `0` for that reads as "no tagged visit arrived", which is
      a measurement nobody made. `rows.length` is the test: rows present and
      none carrying a utm_campaign IS a measured nought.
    */
    if (!rows.length) {
      taggedViews = null;
      notes.push(
        `No UTM rows have been collected for this venture's website(s) over ${utmWindow} complete days, ` +
          "so the tagged views are NOT MEASURED rather than nought. The collector reads a few sites a " +
          "pass; this one has not had its turn yet.",
      );
    } else {
      taggedViews = tagged.reduce((a, b) => a + b.views, 0);
      if (!tagged.length)
        notes.push(
          "UTM rows exist for this venture's website(s) and none of them carries a utm_campaign, so the " +
            "tagged views are a measured nought: visits arrived with query strings that were not campaign tags.",
        );
    }
    if (tagged.length && !tagged.some((t) => t.matchedCampaignId))
      notes.push(
        "None of the tagged views carry a utm_campaign matching a mapped campaign's NAME. Either the links were tagged with something else, or these visits came from somewhere that is not Meta.",
      );
  }

  /* ---- conversions, from the setting ---- */
  const wanted = conversionEvents().get(venture.slug.toLowerCase()) ?? [];
  const conversions: VentureJoin["conversions"] = [];
  if (!wanted.length)
    notes.push(
      `No conversion events are named for “${venture.slug}”. Nothing in Umami says which event matters; set them under Integrations → Web analytics.`,
    );
  else if (sites.length) {
    const q = sites.map(() => "?").join(",");
    for (const event of wanted) {
      const rows = db
        .prepare(
          `SELECT website_id, occurrences, participants FROM web_events
            WHERE website_id IN (${q}) AND window_days = 30 AND event_name = ?`,
        )
        .all(...sites, event) as { website_id: string; occurrences: number | null; participants: number | null }[];
      if (!rows.length)
        notes.push(`No “${event}” row was collected for this venture's sites over 30 complete days.`);
      for (const r of rows)
        conversions.push({
          event,
          websiteId: r.website_id,
          occurrences: r.occurrences,
          participants: r.participants,
        });
    }
  }

  return {
    venture: { id: venture.id, slug: venture.slug, name: venture.name, stage: venture.stage },
    windowDays,
    startDay,
    endDay,
    campaigns,
    spend: [...spendByCurrency].map(([currency, amount]) => ({
      currency,
      amount: Math.round(amount * 100) / 100,
    })),
    clicks: sum(campaigns.map((c) => c.clicks)),
    impressions: sum(campaigns.map((c) => c.impressions)),
    tagged,
    taggedViews,
    conversions,
    notes,
  };
}

/* ------------------------------------------------------ blended efficiency */

export type Blended = {
  month: string;
  /** Per currency, from the finance area's own venture revenue. */
  revenue: { currency: string; gross: number; net: number }[];
  spend: { currency: string; amount: number }[];
  /** Revenue ÷ spend, per currency and ONLY where both are in that same
   *  currency. Null everywhere else. */
  ratio: { currency: string; value: number | null; note: string }[];
  /** The event-property revenue the site itself reported, where a setting
   *  named one. A completely different measurement from the ledger above and
   *  never added to it. */
  siteReported: {
    event: string;
    property: string;
    sum: number | null;
    count: number | null;
    unit: string | null;
    note: string;
  } | null;
  unavailable: string[];
  rules: string[];
};

/**
 * The BLENDED efficiency line — and the four sentences that keep it honest.
 *
 * Revenue comes from `finance/attribution.ts`, which is where this box's one
 * venture-level revenue answer already lives; re-deriving it here would be a
 * second, quietly different answer to the same question. It is loaded through
 * a guarded dynamic import so this area still works on an installation where
 * the finance area is absent or refuses.
 */
export async function blended(
  venture: VentureRow,
  month: string,
  spend: { currency: string; amount: number }[],
): Promise<Blended> {
  const unavailable: string[] = [];
  let revenue: Blended["revenue"] = [];
  try {
    const finance = await import("../finance/attribution.ts");
    const r = finance.ventureRevenue(venture, month);
    /* `CurrencyTotals` is `{byCurrency, unpriced}` — the second field is how
       many revenue lines had no amount at all, and it is carried through as a
       note rather than dropped, because a total that silently omitted rows is
       the thing that field exists to prevent. */
    const currencies = new Set([...Object.keys(r.gross.byCurrency), ...Object.keys(r.net.byCurrency)]);
    revenue = [...currencies].sort().map((currency) => ({
      currency,
      gross: r.gross.byCurrency[currency] ?? 0,
      net: r.net.byCurrency[currency] ?? 0,
    }));
    if (r.net.unpriced)
      unavailable.push(
        `${r.net.unpriced} revenue line(s) for ${month} carried no amount and are not in the total above.`,
      );
    unavailable.push(...r.unavailable);
  } catch (err) {
    unavailable.push(
      `The finance area's venture revenue could not be read (${err instanceof Error ? err.message : String(err)}), so there is no revenue side to this ratio.`,
    );
  }

  const spendBy = new Map(spend.map((s) => [s.currency, s.amount]));
  const ratio: Blended["ratio"] = [];
  for (const r of revenue) {
    const s = spendBy.get(r.currency);
    ratio.push({
      currency: r.currency,
      value: s && s > 0 ? Math.round((r.net / s) * 1000) / 1000 : null,
      note:
        s && s > 0
          ? `Net ${r.currency} revenue for ${month} ÷ ${r.currency} ad spend over the window above. BLENDED: the revenue is everything the business took, not revenue attributed to an advertisement, and the two spans do not line up.`
          : `No ${r.currency} ad spend in the window, so there is nothing to divide by. This is not a ratio of zero.`,
    });
  }
  for (const s of spend)
    if (!revenue.some((r) => r.currency === s.currency))
      unavailable.push(
        `${s.currency} ad spend has no ${s.currency} revenue beside it, so no ratio is computed for it. This box fetches no exchange rate.`,
      );

  /* ---- the site's own money figure, where a setting named one ---- */
  let siteReported: Blended["siteReported"] = null;
  const source = revenueSources().get(venture.slug.toLowerCase());
  if (source) {
    const sites = linkedUmamiSites(venture.id);
    if (sites.length) {
      const q = sites.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT num_sum, num_count, unit FROM web_event_props
            WHERE website_id IN (${q}) AND window_days = 30
              AND event_name = ? AND property = ?`,
        )
        .all(...sites, source.event, source.property) as {
        num_sum: number | null;
        num_count: number | null;
        unit: string | null;
      }[];
      const s = sum(rows.map((r) => r.num_sum));
      const c = sum(rows.map((r) => r.num_count));
      siteReported = {
        event: source.event,
        property: source.property,
        sum: s,
        count: c,
        /* Read fresh from the setting, with the stored value as the fallback —
           see the same decision in routes.ts. */
        unit: unitFor(source.event, source.property) ?? rows.find((r) => r.unit)?.unit ?? null,
        note:
          "This is what the SITE reported through an Umami event property over 30 complete days. It is not the ledger, it is not reconciled with Stripe, and it must never be added to the revenue above — the same sale would be counted twice.",
      };
      if (!rows.length)
        unavailable.push(
          `No “${source.event}.${source.property}” property rows were collected for this venture's sites.`,
        );
    }
  }

  return {
    month,
    revenue,
    spend,
    ratio,
    siteReported,
    unavailable,
    rules: [
      "This is BLENDED EFFICIENCY, not return on ad spend. Nothing here attributes a euro of revenue to an advertisement, a click or a session.",
      "The revenue window is a CALENDAR MONTH and the spend window is a number of complete days. They do not line up and the ratio is an indication, not a rate.",
      "Nothing is added across currencies, in either direction, and a ratio exists only where revenue and spend are in the same one.",
      "A site-reported revenue property and the ledger revenue are two measurements of overlapping money and are never summed.",
    ],
  };
}
