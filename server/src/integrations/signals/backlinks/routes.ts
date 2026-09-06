/**
 * The link profile, read.
 *
 * THERE IS NO COMBINED FIGURE ON THIS DOCUMENT AND THERE WILL NOT BE ONE.
 * Three sources answer "who links to this host" and they disagree by design:
 * a crawler that fetched twenty-five pages, an index that remembers some of
 * them, and a commons that captured a domain are three measurements of three
 * different populations. Adding their referring-domain counts would double
 * every host that two of them know about; taking the largest would report
 * Bing's sample as a census. So every number is published UNDER THE SOURCE
 * THAT SAID IT, with that source's confidence beside it, and
 * `referringDomains.combined` is null with the reason attached — the same
 * shape this codebase uses for money in two currencies and for de-duplicated
 * visitors.
 *
 * `null` HERE MEANS ASKED AND NOT TOLD, and `ok` says which kind of silence
 * it is: 1 the source answered, 0 it refused, null it was never asked (no
 * Bing account connected, no index resolved). A zero with `ok: 1` is a
 * measurement — Bing genuinely knows of no page of ours with a link in — and
 * it must never be rendered like a null.
 */
import { Hono } from "hono";
import { configValue } from "../../../db.ts";
import { CONFIDENCE, SOURCE_LABEL, INDEGREE_NOTE, parseHosts, type Source } from "./sources.ts";
import { backlinkRows, backlinkSources, referringDomains } from "../db.ts";
import { EVERY_HOURS } from "./collect.ts";

export const backlinkRoutes = new Hono();

const SOURCES: Source[] = ["verify", "bing", "commoncrawl"];

backlinkRoutes.get("/", (c) => {
  const configured = parseHosts(configValue("backlinks", "hosts"));
  const rows = backlinkSources();

  const hosts = configured.map((host) => {
    const mine = rows.filter((r) => r.host === host);
    const links = backlinkRows(host);
    const sources = SOURCES.map((source) => {
      const row = mine.find((r) => r.source === source);
      return {
        source,
        label: SOURCE_LABEL[source],
        confidence: CONFIDENCE[source],
        /** 1 answered · 0 refused · null never asked. See the header. */
        ok: row ? (row.ok === null ? null : row.ok === 1) : null,
        asked: !!row,
        seenAt: row?.ts ?? null,
        referringDomains: row?.referring_domains ?? null,
        backlinks: row?.backlinks ?? null,
        linkedPages: row?.linked_pages ?? null,
        crawlPages: row?.crawl_pages ?? null,
        /** Only the verification crawler fills these. `checked` is pages
         *  fetched, `live` those that still carried the link, `followed`
         *  those of the live ones that pass authority. */
        verified: row?.checked === null || row === undefined
          ? null
          : { checked: row.checked, live: row.live, followed: row.followed },
        note: row?.note ?? null,
        error: row?.error ?? null,
      };
    });

    const seen = mine.map((r) => r.ts).sort();
    return {
      host,
      sources,
      /* From `referringDomains` in the area's own db.ts — the same answer the
         authority estimate is built on, so the two cannot drift. `bySource`
         keeps a key for every source including the never-asked ones;
         `perSource` carries only the rows that exist. */
      referringDomains: {
        ...referringDomains(host),
        bySource: Object.fromEntries(sources.map((s) => [s.source, s.referringDomains])),
        note:
          "not summed. The sources overlap and do not agree — a host both Bing " +
          "and the crawler know about would be counted twice — and neither is a " +
          "census. Read them apart, weighted by the confidence on each row. " +
          "`best` is the largest single source with that source named — never a total.",
      },
      links: links.map((l) => ({
        source: l.source,
        fromDomain: l.from_domain,
        fromUrl: l.from_url,
        toUrl: l.to_url,
        anchor: l.anchor,
        /** Three-valued from the crawler, null from an index: an index cannot
         *  say whether a link is still on the page. */
        live: l.live === null ? null : l.live === 1,
        nofollow: l.nofollow === null ? null : l.nofollow === 1,
        error: l.error,
        seenAt: l.seen_at,
      })),
      seenAt: seen.at(-1) ?? null,
      collected: !!mine.length,
    };
  });

  return c.json({
    hosts,
    confidence: CONFIDENCE,
    sourceLabels: SOURCE_LABEL,
    summary: {
      configured: configured.length,
      collected: hosts.filter((h) => h.collected).length,
      /** Hosts on the list that no source has answered for yet — a fresh list
       *  before its first run, which is a state and not a fault. */
      pending: hosts.filter((h) => !h.collected).map((h) => h.host),
      everyHours: EVERY_HOURS,
      seenAt: hosts.map((h) => h.seenAt).filter(Boolean).sort().at(-1) ?? null,
    },
    notes: [
      INDEGREE_NOTE,
      "Every figure is one source's. Nothing on this document adds two sources " +
        "together, and `combined: null` is a refusal rather than a missing value.",
      "`ok: false` is a source that refused; `ok: null` is one that was never " +
        "asked. A count of 0 with `ok: true` is a real measurement of nothing.",
      "The verification crawler only ever visits pages another source named. It " +
        "verifies claims; it does not go hunting, so a host nobody has claimed a " +
        "link for has nothing to verify.",
      `Collected once every ${EVERY_HOURS} hours per host — these sources are ` +
        "slow, public and do not move between breakfast and lunch.",
    ],
  });
});

/** What a venture could be linked to. The host IS the entity here, which is
 *  the simplest case in the whole seam: a venture with that host is obviously
 *  about it. */
backlinkRoutes.get("/entities", (c) => {
  const configured = parseHosts(configValue("backlinks", "hosts"));
  return c.json({
    entities: configured.map((host) => ({
      plugin: "backlinks",
      entity: host,
      label: host,
      host,
    })),
  });
});
