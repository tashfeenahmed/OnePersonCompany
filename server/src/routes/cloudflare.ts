/**
 * Cloudflare: the zones, what they served, and where they actually delegate.
 *
 * ONE ROUTE FOR THE WHOLE BOARD, the way /api/domains is one route for the
 * portfolio: a zones page asks the same question of the same twenty-three rows
 * from a dozen cards, and a dozen requests for one answer is a burst the box
 * does not need to serve.
 *
 * EVERY TOTAL IS COMPUTED ON THE READ. Nothing stored says "604k requests this
 * week"; it says "86,168 on the 2nd, on this zone", and the window is summed
 * when somebody asks. A stored weekly figure is wrong tomorrow morning and
 * badly wrong after a day of failed collections — which is the day somebody
 * actually looks.
 *
 * THE WINDOW ENDS YESTERDAY, and the document says so. Cloudflare is still
 * writing today's bucket, so a seven-day total that included it would fall
 * every morning and climb all afternoon: a sawtooth describing this box's clock
 * rather than anything the zones did. Today is carried separately, marked
 * `partial`, because leaving it out entirely would be a hole and folding it in
 * would be a lie.
 *
 * THE JOIN THIS ROUTE EXISTS FOR. Cloudflare knows which nameservers it
 * ASSIGNED a zone. The registrars know which nameservers the domain actually
 * DELEGATES to. Neither of them knows the other, and the gap between the two is
 * the single most valuable thing on this page — a zone whose registrar points
 * somewhere else is a zone whose records are not the ones the internet is being
 * served, and a domain at the registrar with no zone at all is a name this
 * dashboard's DNS half has never heard of. Both sides are already in this
 * database; the join is computed here, on every read, because a stored verdict
 * would go stale the moment either side moved.
 */
import { Hono } from "hono";
import {
  allDomains,
  cloudflareRegistrar,
  cloudflareState,
  cloudflareTraffic,
  cloudflareZones,
  type CloudflareTrafficRow,
} from "../db.ts";
import { CANNOT, CLOUDFLARE_GRAPHQL, WINDOW_DAYS } from "../providers/cloudflare.ts";
import { CLOUDFLARE_WINDOW_DAYS } from "../collector.ts";
import { daysUntil } from "../providers/domains.ts";

export const cloudflareRoutes = new Hono();

/** SQLite hands integers back as numbers and NULLs as null; this is only here
 *  so a 0/1 column reads as the boolean it was written as. */
const bool = (v: number | null): boolean | null => (v === null ? null : v === 1);

/** A nameserver, comparably. Case and a trailing dot are presentation, and two
 *  registrars spell the same delegation both ways. */
const host = (n: string) => n.trim().toLowerCase().replace(/\.$/, "");

const sameSet = (a: string[], b: string[]) => {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
};

/** Is this a Cloudflare nameserver at all? Used only to tell "delegated to a
 *  DIFFERENT Cloudflare account" apart from "delegated off Cloudflare", which
 *  are two very different mornings. */
const isCloudflareNs = (n: string) => n.endsWith(".ns.cloudflare.com");

type Alignment = {
  /** "aligned" | "elsewhere-on-cloudflare" | "off-cloudflare" | "unknown" |
   *  "no-registrar-row" — never a boolean, because three of these five are not
   *  "no". */
  state: string;
  /** One sentence, ready to put on a card. */
  note: string;
  registrar: string | null;
  account: string | null;
  nameservers: string[] | null;
};

cloudflareRoutes.get("/", (c) => {
  const requested = Number(c.req.query("days") ?? CLOUDFLARE_WINDOW_DAYS);
  const days = Number.isFinite(requested)
    ? Math.min(Math.max(Math.round(requested), 1), 90)
    : CLOUDFLARE_WINDOW_DAYS;

  const zoneRows = cloudflareZones();
  const state = cloudflareState();
  const registrarRows = cloudflareRegistrar();

  const today = new Date().toISOString().slice(0, 10);
  const through = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  // One day wider than the window, so today's partial bucket comes back too and
  // can be reported as what it is rather than silently dropped.
  const rows = cloudflareTraffic(days + 1);
  const inWindow = rows.filter((r) => r.day >= since && r.day <= through);
  const todayRows = rows.filter((r) => r.day === today);

  /* --------------------------------------------------------- per zone */

  const byZone = new Map<string, CloudflareTrafficRow[]>();
  for (const r of inWindow) {
    const list = byZone.get(r.zone_id);
    if (list) list.push(r);
    else byZone.set(r.zone_id, [r]);
  }

  /**
   * A nullable sum. Null wins over a partial total: if any day in the window
   * came back from a field set that could not ask for threats, the week's
   * threat count is unknown rather than an undercount presented as a count.
   */
  const sumOrNull = (list: CloudflareTrafficRow[], pick: (r: CloudflareTrafficRow) => number | null) => {
    let total = 0;
    for (const r of list) {
      const v = pick(r);
      if (v === null) return null;
      total += v;
    }
    return list.length ? total : null;
  };

  /* ------------------------------------------------------ the drift join */

  const domains = allDomains();
  const heldByName = new Map<string, (typeof domains)[number]>();
  const claimedTwice: string[] = [];
  for (const d of domains) {
    const name = d.name.toLowerCase();
    if (heldByName.has(name)) claimedTwice.push(name);
    else heldByName.set(name, d);
  }

  const zoneNames = new Set(zoneRows.map((z) => z.name.toLowerCase()));

  function align(zoneName: string, assigned: string[] | null): Alignment {
    const held = heldByName.get(zoneName.toLowerCase());
    if (!held)
      return {
        state: "no-registrar-row",
        note:
          "No connected registrar holds this name — it is registered somewhere " +
          "this dashboard cannot read, so nothing here can vouch for its delegation.",
        registrar: null,
        account: null,
        nameservers: null,
      };

    const registrarNs = (
      held.nameservers ? (JSON.parse(held.nameservers) as string[]) : []
    ).map(host);
    const base = {
      registrar: held.registrar,
      account: held.account_label,
      nameservers: registrarNs.length ? registrarNs : null,
    };

    if (!registrarNs.length)
      return {
        ...base,
        state: "unknown",
        note: `${held.registrar} did not report this name's nameservers, so whether it still points at Cloudflare is unknown — not confirmed.`,
      };

    const cfNs = (assigned ?? []).map(host);
    if (cfNs.length && sameSet(registrarNs, cfNs))
      return { ...base, state: "aligned", note: `Delegated to this zone's own Cloudflare nameservers at ${held.registrar}.` };

    if (registrarNs.every(isCloudflareNs))
      return {
        ...base,
        state: "elsewhere-on-cloudflare",
        note:
          `${held.registrar} delegates this name to ${registrarNs.join(", ")}, which is ` +
          `Cloudflare but not the pair this zone was assigned (${cfNs.join(", ") || "none reported"}) — ` +
          `usually a second Cloudflare account holding the live zone.`,
      };

    return {
      ...base,
      state: "off-cloudflare",
      note:
        `${held.registrar} delegates this name to ${registrarNs.join(", ")}. The records ` +
        `in this Cloudflare zone are NOT what the internet is being served.`,
    };
  }

  const zones = zoneRows.map((z) => {
    const list = byZone.get(z.zone_id) ?? [];
    const requests = list.reduce((n, r) => n + r.requests, 0);
    const cached = list.reduce((n, r) => n + r.cached, 0);
    const assigned = z.name_servers ? (JSON.parse(z.name_servers) as string[]) : null;

    return {
      id: z.zone_id,
      name: z.name,
      accountId: z.account_id,
      account: z.account_label,
      cfAccount: z.cf_account_name,
      status: z.status,
      paused: z.paused === 1,
      plan: z.plan,
      /** "full" or "partial". A partial zone is a CNAME setup serving part of
       *  the domain, which changes what its request count is a count OF. */
      type: z.zone_type,
      createdOn: z.created_on,
      nameServers: assigned,
      records: z.records,
      proxied: z.proxied,
      onPages: bool(z.on_pages),
      email:
        z.mx === null
          ? null
          : {
              mx: z.mx === 1,
              spf: z.spf === 1,
              dmarc: z.dmarc === 1,
              dmarcPolicy: z.dmarc_policy,
              dkim: bool(z.dkim),
            },
      recordsNote: z.records_note,
      /*
        NULL TRAFFIC AND ZERO TRAFFIC ARE DIFFERENT ANSWERS, and this is the
        line where that is decided. A zone with a `trafficNote` was never
        measured; a zone with rows that all read zero was measured and served
        nothing. Drawing both as 0 would put "no visitors" under a zone nobody
        asked about.
      */
      traffic: list.length
        ? {
            requests,
            cached,
            /** A ratio over zero requests is not 0%, it is unknowable. */
            cacheRatio: requests ? Number((cached / requests).toFixed(3)) : null,
            bytes: list.reduce((n, r) => n + r.bytes, 0),
            threats: sumOrNull(list, (r) => r.threats),
            pageViews: sumOrNull(list, (r) => r.page_views),
            /** Summed across DAYS, so anybody who came back on Tuesday is in it
             *  twice. Named `uniquesByDay` so no caller can read it as people. */
            uniquesByDay: sumOrNull(list, (r) => r.uniques),
            /** The busiest single day's unique count — the only figure here
             *  that is a real headcount, because Cloudflare de-duplicates
             *  within a day and not across them. */
            uniquesBusiestDay: list.reduce<number | null>(
              (m, r) => (r.uniques === null ? m : Math.max(m ?? 0, r.uniques)),
              null,
            ),
            status: {
              s2xx: sumOrNull(list, (r) => r.s2xx),
              s3xx: sumOrNull(list, (r) => r.s3xx),
              s4xx: sumOrNull(list, (r) => r.s4xx),
              s5xx: sumOrNull(list, (r) => r.s5xx),
            },
            /** How many complete days actually landed. A zone added on Tuesday
             *  has fewer of them than the window asked for, and a card that
             *  says "7d" over three days has quietly changed meaning. */
            days: list.length,
            fields: [...new Set(list.map((r) => r.fields))].join(","),
          }
        : null,
      trafficNote: list.length
        ? null
        : (z.traffic_note ??
          `No daily rollup for this zone in the ${days} days to ${through}.`),
      alignment: align(z.name, assigned),
      seenAt: z.seen_at,
    };
  });

  /* ----------------------------------------------------- the daily line */

  const dayKeys = [...new Set([...inWindow, ...todayRows].map((r) => r.day))].sort();
  const daily = dayKeys.map((day) => {
    const list = rows.filter((r) => r.day === day);
    const requests = list.reduce((n, r) => n + r.requests, 0);
    const cached = list.reduce((n, r) => n + r.cached, 0);
    return {
      day,
      requests,
      cached,
      bytes: list.reduce((n, r) => n + r.bytes, 0),
      threats: sumOrNull(list, (r) => r.threats),
      pageViews: sumOrNull(list, (r) => r.page_views),
      /** Summed across ZONES on one day. Somebody who read two of these sites
       *  that morning is in it twice; Cloudflare has no cross-zone identity to
       *  de-duplicate them with, and inventing one would be worse. */
      uniquesByZone: sumOrNull(list, (r) => r.uniques),
      zones: list.length,
      /*
        TODAY IS PARTIAL AND SAYS SO. Cloudflare aggregates into UTC days and is
        still filling this one in; drawn beside six finished days it is a cliff
        that never happened. It is carried rather than dropped, so a reader can
        see the day is in progress instead of wondering where it went.
      */
      partial: day === today,
    };
  });

  /* ------------------------------------------------------------ summary */

  const measured = zones.filter((z) => z.traffic);
  const requests = measured.reduce((n, z) => n + z.traffic!.requests, 0);
  const cached = measured.reduce((n, z) => n + z.traffic!.cached, 0);
  const withRecords = zones.filter((z) => z.records !== null);

  const busiest = [...measured].sort((a, b) => b.traffic!.requests - a.traffic!.requests)[0] ?? null;
  const silent = measured.filter((z) => z.traffic!.requests === 0).map((z) => z.name);

  /* --------------------------------------------------- the join, counted */

  const byState = (s: string) => zones.filter((z) => z.alignment.state === s);
  const registrarOnly = domains
    .filter((d) => !zoneNames.has(d.name.toLowerCase()))
    .map((d) => ({
      name: d.name,
      registrar: d.registrar,
      account: d.account_label,
      expiresAt: d.expires_at,
      /* Computed here, on every read, exactly as /api/domains computes it. A
         stored countdown is wrong by one the next morning. */
      expiresInDays: daysUntil(d.expires_at, new Date()),
      nameservers: d.nameservers ? (JSON.parse(d.nameservers) as string[]) : null,
    }));

  /* -------------------------------------------------------- the registrar */

  const registrarReadable = state.some((s) => s.registrar_readable === 1);
  const registrarNotes = state
    .map((s) => s.registrar_note)
    .filter((n): n is string => Boolean(n));

  return c.json({
    generatedAt: new Date().toISOString(),
    /** When the zones were last COLLECTED — not when this document was built.
     *  Every figure on it is recomputed per request, so the route's own clock
     *  would say "just now" about numbers read six hours ago. */
    seenAt: zoneRows[0]?.seen_at ?? state[0]?.seen_at ?? null,
    window: {
      days,
      since,
      /** The last COMPLETE UTC day. Everything summed above stops here. */
      through,
      /** What the collector holds at most, whatever this window asked for. */
      collectedDays: WINDOW_DAYS,
      note:
        `Complete UTC days only, ${since} to ${through}. Today is carried in ` +
        `\`daily\` marked partial and is in none of the totals.`,
    },
    zones,
    daily,
    summary: {
      zones: zones.length,
      active: zones.filter((z) => z.status === "active" && !z.paused).length,
      paused: zones.filter((z) => z.paused).length,
      /** Plans, because a Free zone and a Pro zone do not have the same
       *  analytics behind them and a reader should not have to guess which. */
      byPlan: zones.reduce<Record<string, number>>((acc, z) => {
        const key = z.plan ?? "not reported";
        acc[key] = (acc[key] ?? 0) + 1;
        return acc;
      }, {}),
      withTraffic: measured.length,
      withoutTraffic: zones.length - measured.length,
      requests,
      cached,
      cacheRatio: requests ? Number((cached / requests).toFixed(3)) : null,
      bytes: measured.reduce((n, z) => n + z.traffic!.bytes, 0),
      threats: measured.some((z) => z.traffic!.threats === null)
        ? null
        : measured.reduce((n, z) => n + (z.traffic!.threats ?? 0), 0),
      pageViews: measured.some((z) => z.traffic!.pageViews === null)
        ? null
        : measured.reduce((n, z) => n + (z.traffic!.pageViews ?? 0), 0),
      /*
        NO PORTFOLIO-WIDE UNIQUE COUNT, and the field that would hold one says
        why instead. Cloudflare de-duplicates visitors within one zone and one
        day; there is no identity that spans zones or days, so every way of
        adding these counts the same person more than once. The per-zone and
        per-day figures above are true where they are, and this is the same
        rule GitHub's traffic follows for the same reason.
      */
      uniques: null,
      uniquesNote:
        "Cloudflare de-duplicates visitors per zone per day, so no total across " +
        "zones or days is a headcount. Per-zone daily figures are on each zone.",
      records: withRecords.length ? withRecords.reduce((n, z) => n + (z.records ?? 0), 0) : null,
      proxied: withRecords.length ? withRecords.reduce((n, z) => n + (z.proxied ?? 0), 0) : null,
      recordsUnreadable: zones.filter((z) => z.records === null).length,
      onPages: zones.filter((z) => z.onPages === true).length,
      busiest: busiest && { name: busiest.name, requests: busiest.traffic!.requests },
      /** Measured and served nothing. Named rather than counted, because "which
       *  of these is dormant" is the question the number provokes. */
      silent,
      seenAt: zoneRows[0]?.seen_at ?? null,
    },

    /**
     * Mail posture across the zones that could be read.
     *
     * Counted over `withEmail` rather than over every zone: a zone whose record
     * listing failed has no posture to report, and putting it in the
     * denominator would turn an unreadable zone into a spoofable one.
     */
    email: (() => {
      const withEmail = zones.filter((z) => z.email);
      const sending = withEmail.filter((z) => z.email!.mx || z.email!.spf);
      return {
        zones: withEmail.length,
        unreadable: zones.length - withEmail.length,
        /** Zones that show any sign of handling mail at all. The rest cannot be
         *  called badly configured for not defending a mailbox they do not have. */
        sending: sending.length,
        mx: withEmail.filter((z) => z.email!.mx).length,
        spf: withEmail.filter((z) => z.email!.spf).length,
        dmarc: withEmail.filter((z) => z.email!.dmarc).length,
        /** A DMARC record with `p=none` monitors and enforces nothing. It is
         *  counted apart from "has DMARC" because a card that folds them
         *  together reports protection nobody has. */
        dmarcMonitorOnly: withEmail.filter((z) => z.email!.dmarcPolicy === "none").length,
        dkim: withEmail.filter((z) => z.email!.dkim === true).length,
        dkimMissing: withEmail.filter((z) => z.email!.dkim === false).length,
        dkimUnknown: withEmail.filter((z) => z.email!.dkim === null).length,
      };
    })(),

    /**
     * The two sides of the portfolio, joined.
     *
     * Five states rather than a boolean, because three of them are neither
     * "fine" nor "broken": a name whose registrar reported no nameservers is
     * unknown, a name registered at a registrar with no API here has no row to
     * compare against, and a name delegated to a DIFFERENT pair of Cloudflare
     * nameservers is on Cloudflare and still not on this zone.
     */
    alignment: {
      registrarDomains: domains.length,
      zones: zones.length,
      aligned: byState("aligned").map((z) => z.name),
      offCloudflare: byState("off-cloudflare").map((z) => ({
        name: z.name,
        note: z.alignment.note,
        registrar: z.alignment.registrar,
        nameservers: z.alignment.nameservers,
      })),
      elsewhereOnCloudflare: byState("elsewhere-on-cloudflare").map((z) => ({
        name: z.name,
        note: z.alignment.note,
        registrar: z.alignment.registrar,
        nameservers: z.alignment.nameservers,
      })),
      /** The registrar holds the name and would not say where it points. Not
       *  safe: unknown. */
      unknown: byState("unknown").map((z) => ({
        name: z.name,
        registrar: z.alignment.registrar,
      })),
      /** A zone here that no connected registrar holds. Its renewal date is
       *  invisible to this dashboard, which is the finding. */
      zoneOnly: byState("no-registrar-row").map((z) => z.name),
      /** A name a registrar holds with no Cloudflare zone at all. Invisible to
       *  every DNS card on this board, so it is listed rather than summarised. */
      registrarOnly,
      /** Two registrars claiming one name. Empty is the ordinary answer. */
      claimedTwice,
      note:
        `Joined against ${domains.length} domain(s) from the connected registrars. ` +
        `A zone with no registrar row is registered somewhere this dashboard cannot read; ` +
        `it is not a zone that has lapsed.`,
    },

    /**
     * Cloudflare Registrar, which on this account holds nothing.
     *
     * `readable` is the field that matters. An empty list from an endpoint that
     * answered is a measurement — no domain here is registered at Cloudflare —
     * and an empty list from an endpoint that refused is nothing at all. A card
     * that could not tell them apart would report a portfolio of zero.
     */
    registrar: {
      readable: registrarReadable,
      count: registrarRows.length,
      domains: registrarRows.map((r) => ({
        name: r.name,
        account: r.account_label,
        expiresAt: r.expires_at,
        expiresInDays: daysUntil(r.expires_at, new Date()),
        autoRenew: bool(r.auto_renew),
        locked: bool(r.locked),
        registrar: r.registrar,
        status: r.status,
      })),
      note: registrarNotes.length
        ? registrarNotes.join("; ")
        : registrarReadable
          ? "Asked and answered: no domain on this account is registered at Cloudflare Registrar."
          : "Not read.",
    },

    accounts: state.map((s) => ({
      id: s.account_id,
      label: s.account_label,
      cfAccount: s.cf_account_name,
      zones: s.zones,
      registrarReadable: s.registrar_readable === 1,
      registrarCount: s.registrar_count,
      registrarNote: s.registrar_note,
      analyticsZones: s.analytics_zones,
      analyticsNote: s.analytics_note,
      seenAt: s.seen_at,
    })),

    /** What was asked of Cloudflare and refused, dated. The evidence rather
     *  than the verdict — a reader who goes looking for a Pages figure or a WAF
     *  count finds out why there isn't one instead of assuming a broken
     *  collector. `endpoint` is here so the block names the surface it is
     *  talking about. */
    cannot: { ...CANNOT, graphql: CLOUDFLARE_GRAPHQL },
  });
});
