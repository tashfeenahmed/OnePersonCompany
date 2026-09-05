/**
 * Backlinks, collected — once per configured host, once a day.
 *
 * A DAY CLOCK, PER HOST, NOT PER RUN. These sources are slow and public:
 * Common Crawl's index is a shared service, the verification crawler goes to
 * twenty-five strangers' servers at one request a second, and none of the
 * three answers change between breakfast and lunch. So a host that answered
 * inside the last twenty-four hours is skipped and the run says `fresh`,
 * while a host NOTHING HAS EVER ASKED ABOUT is collected immediately whatever
 * the clock says — otherwise adding a host at nine o'clock puts a row on the
 * page that stays empty until tomorrow, and the point of adding it was to see
 * it.
 *
 * ONE HOST'S FAILURE IS ONE HOST'S FAILURE. Each source of each host writes
 * its own row with its own `ok`, its own error and its own timestamp, so a
 * Bing key that expired leaves the crawl presence and the verified links
 * exactly as they were. The run fails only when every host failed at every
 * source, which is the shape "nothing about this integration works" actually
 * has.
 *
 * BING IS BORROWED, NOT ASKED FOR AGAIN. The key comes from the
 * `bing-webmaster` plugin's own accounts, so connecting this integration is
 * typing a list of hosts and nothing else. When that plugin is not connected
 * the Bing row is written with `ok: null` — not asked — and the note names the
 * page to go and fill in. That is a different sentence from "Bing answered and
 * knows of no links", which is what `ok: 1` with a zero means, and the two
 * must never render alike.
 */
import { configValue, finishRun, record, startRun, upsertPlugin } from "../../../db.ts";
import * as accounts from "../../../accounts.ts";
import type { CollectResult } from "../../manifest.ts";
import {
  BING_DETAIL_URLS,
  CC_LIMIT,
  CONFIDENCE,
  INDEGREE_NOTE,
  MAX_ROWS,
  Pace,
  VERIFY_MAX,
  bingLinkedPages,
  bingLinkingUrls,
  bingSiteFor,
  crawlPresence,
  latestIndex,
  parseHosts,
  registrable,
  scrub,
  verifyLink,
  type CrawlIndex,
  type LinkingUrl,
} from "./sources.ts";
import {
  backlinkLastRun,
  forgetBacklinkHosts,
  writeBacklinkRows,
  writeBacklinkSource,
} from "../db.ts";

export const PLUGIN = "backlinks";

/** How stale a host's answer has to be before it is asked again. */
export const EVERY_HOURS = 24;

/** The whole run's wall clock. The scheduler ticks every thirty minutes and a
 *  collection that outlives its own interval is two collections racing. */
const RUN_MS = 10 * 60_000;

/** One request a second at the verification crawler — the one number in this
 *  file that is a promise to somebody else's server rather than a tuning
 *  choice. Bing self-throttles at the same pace; Common Crawl gets two
 *  seconds because its index is one shared machine. */
const PACES = () => ({
  verify: new Pace(1_000),
  bing: new Pace(1_000),
  cc: new Pace(2_000),
});

export type BacklinksSummary = CollectResult & {
  runId: number;
  hosts: number;
  collected: number;
  skipped: number;
  warnings: string[];
};

export async function collectBacklinks(): Promise<BacklinksSummary> {
  const runId = startRun(PLUGIN);
  const hosts = parseHosts(configValue(PLUGIN, "hosts"));

  if (!hosts.length) {
    const error =
      "No hosts configured. Backlinks needs no key, but it does need to know " +
      "which sites are yours — set them on the plugin page.";
    finishRun(runId, false, undefined, error);
    upsertPlugin(PLUGIN, false, error);
    return { ok: false, runId, hosts: 0, collected: 0, skipped: 0, warnings: [], error };
  }

  // A host taken off the list takes its rows with it, or it would go on being
  // answered by a route whose list no longer names it.
  forgetBacklinkHosts(hosts);

  const deadline = Date.now() + RUN_MS;
  const paces = PACES();
  const warnings: string[] = [];

  const due = hosts.filter((host) => {
    const at = backlinkLastRun(host);
    return !at || Date.now() - Date.parse(at) >= EVERY_HOURS * 3_600_000;
  });

  if (!due.length) {
    const note = `fresh — all ${hosts.length} host(s) answered inside the last ${EVERY_HOURS}h`;
    finishRun(runId, true, note);
    upsertPlugin(PLUGIN, true, null);
    return { ok: true, runId, hosts: hosts.length, collected: 0, skipped: hosts.length, warnings: [], note };
  }

  /* The index list, ONE call for the whole run rather than one per host. */
  let index: CrawlIndex | null = null;
  {
    const got = await latestIndex();
    index = got.index;
    if (got.error) warnings.push(`Common Crawl's index list could not be read (${got.error})`);
  }

  /* The Bing key, borrowed from that plugin's first connected account. One
     account's key covers every site it has verified, so there is nothing to
     choose between accounts and the first ready one is the answer. */
  const { ready } = accounts.credentialed("bing-webmaster", ["key"], "collect_backlinks");
  const bingKey = ready[0]?.values.key ?? null;

  let worked = 0;
  for (const host of due) {
    if (Date.now() >= deadline) {
      warnings.push(`${host}: the run's clock ran out before it was reached`);
      continue;
    }
    const ok = await collectHost(host, index, bingKey, paces, deadline, warnings);
    if (ok) worked += 1;
  }

  const note =
    `${worked}/${due.length} host(s) collected` +
    (hosts.length - due.length ? `, ${hosts.length - due.length} fresh` : "") +
    (bingKey ? "" : " · no Bing key, so nothing named a linking page");

  const allFailed = worked === 0;
  finishRun(runId, !allFailed, note, warnings.join("; ") || undefined);
  upsertPlugin(PLUGIN, true, allFailed ? warnings.join("; ") || "nothing answered" : null);

  return {
    ok: !allFailed,
    runId,
    hosts: hosts.length,
    collected: worked,
    skipped: hosts.length - due.length,
    warnings,
    note,
    error: allFailed ? warnings.join("; ") || "nothing answered" : null,
  };
}

/** One host, three sources, three rows. Returns whether ANY source answered. */
async function collectHost(
  host: string,
  index: CrawlIndex | null,
  bingKey: string | null,
  paces: ReturnType<typeof PACES>,
  deadline: number,
  warnings: string[],
): Promise<boolean> {
  let answered = false;

  /* ------------------------------------------------------- Common Crawl */
  if (index) {
    await paces.cc.wait();
    const { presence, error } = await crawlPresence(index, host);
    writeBacklinkSource({
      host,
      source: "commoncrawl",
      ok: error ? 0 : 1,
      referring_domains: null,
      backlinks: null,
      linked_pages: null,
      crawl_pages: presence?.pages ?? null,
      checked: null,
      live: null,
      followed: null,
      confidence: CONFIDENCE.commoncrawl,
      note:
        (presence?.atLeast
          ? `a FLOOR — the index answered with a full page of ${CC_LIMIT} results. `
          : "") + INDEGREE_NOTE,
      error,
    });
    if (error) warnings.push(`${host} · Common Crawl: ${error}`);
    else {
      answered = true;
      record(`backlinks.${host}.crawlPages`, presence!.pages, { source: "commoncrawl" });
    }
  } else {
    writeBacklinkSource({
      host,
      source: "commoncrawl",
      ok: null,
      referring_domains: null, backlinks: null, linked_pages: null, crawl_pages: null,
      checked: null, live: null, followed: null,
      confidence: CONFIDENCE.commoncrawl,
      note: INDEGREE_NOTE,
      error: "no Common Crawl index could be resolved this run",
    });
  }

  /* --------------------------------------------------------------- Bing */
  const linking: LinkingUrl[] = [];
  if (!bingKey) {
    writeBacklinkSource({
      host,
      source: "bing",
      // NOT ASKED, which is not the same as asked-and-refused. The note names
      // the page that fixes it.
      ok: null,
      referring_domains: null, backlinks: null, linked_pages: null, crawl_pages: null,
      checked: null, live: null, followed: null,
      confidence: CONFIDENCE.bing,
      note:
        "no Bing Webmaster account is connected, so nothing named a linking " +
        "page and the verification crawler had nothing to look at. Connect " +
        "Bing Webmaster Tools under Integrations — the key is free with a " +
        "verified site.",
      error: null,
    });
  } else {
    try {
      const site = await bingSiteFor(bingKey, host);
      if (!site) {
        writeBacklinkSource({
          host, source: "bing", ok: 0,
          referring_domains: null, backlinks: null, linked_pages: null, crawl_pages: null,
          checked: null, live: null, followed: null,
          confidence: CONFIDENCE.bing,
          note: null,
          error:
            "not a verified site on this Bing account — verify the domain in " +
            "Bing Webmaster Tools and this fills in on the next run",
        });
      } else {
        const { rows, totalPages } = await bingLinkedPages(bingKey, site, paces.bing);
        const inbound = rows.reduce((n, r) => n + (r.count ?? 0), 0);

        // Best-linked pages first: the page with forty links in tells us more
        // per call than the one with one.
        for (const row of [...rows].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)).slice(0, BING_DETAIL_URLS)) {
          if (Date.now() >= deadline) break;
          try {
            linking.push(...(await bingLinkingUrls(bingKey, site, row.url, paces.bing)));
          } catch (err) {
            warnings.push(`${host} · Bing GetUrlLinks: ${scrub(err instanceof Error ? err.message : String(err), bingKey)}`);
          }
        }

        const hosts = new Set<string>();
        for (const d of linking) {
          let from = "";
          try {
            from = registrable(new URL(d.url).hostname);
          } catch {
            continue;
          }
          if (!from || from === host || from.endsWith(`.${host}`)) continue;
          hosts.add(from);
        }

        const shortfall =
          totalPages !== null && totalPages > 1 && rows.length && totalPages > 5
            ? `a floor: Bing paged this over ${totalPages} pages and 5 were read. `
            : "";

        writeBacklinkSource({
          host, source: "bing", ok: 1,
          // Bing can only name the hosts it actually listed. With no detail
          // rows there is no count to give — null, never zero, because "Bing
          // named nobody" and "Bing has nobody to name" are different claims
          // and only the second is a measurement.
          referring_domains: linking.length ? hosts.size : null,
          backlinks: rows.length ? inbound : null,
          linked_pages: rows.length,
          crawl_pages: null,
          checked: null, live: null, followed: null,
          confidence: CONFIDENCE.bing,
          note:
            shortfall +
            (rows.length
              ? `${rows.length} of our own url(s) have links in; ${linking.length} linking url(s) named.`
              : "Bing answered, and it knows of no page of ours with a link into it. " +
                "That is a measurement of zero rather than a missing figure — its own " +
                "crawl stats can still report inbound links, which is a different count."),
          error: null,
        });
        answered = true;
        if (rows.length) record(`backlinks.${host}.linkedPages`, rows.length, { source: "bing" });
        if (linking.length) record(`backlinks.${host}.referringDomains`, hosts.size, { source: "bing" });

        writeBacklinkRows(
          host,
          "bing",
          linking.map((d) => {
            let from = "";
            try {
              from = registrable(new URL(d.url).hostname);
            } catch {
              from = "";
            }
            return {
              from_domain: from,
              from_url: d.url,
              to_url: d.to,
              anchor: d.anchor,
              // An index cannot answer either of these. Only the crawler can,
              // and its rows are stored under its own source.
              live: null,
              nofollow: null,
              error: null,
            };
          }),
          MAX_ROWS,
        );
      }
    } catch (err) {
      const error = scrub(err instanceof Error ? err.message : String(err), bingKey);
      writeBacklinkSource({
        host, source: "bing", ok: 0,
        referring_domains: null, backlinks: null, linked_pages: null, crawl_pages: null,
        checked: null, live: null, followed: null,
        confidence: CONFIDENCE.bing, note: null, error,
      });
      warnings.push(`${host} · Bing: ${error}`);
    }
  }

  /* ----------------------------------------------- the verification crawler */
  /*
    CANDIDATES ARE PAGES SOMETHING ALREADY CLAIMED LINK HERE. Nothing in this
    block guesses a url: a crawler that invented pages to check would report
    every invention as a dead link, and a profile that decays because we made
    the pages up is worse than no profile.
  */
  const candidates = [...new Set(linking.map((d) => d.url))].slice(0, VERIFY_MAX);
  if (!candidates.length) {
    writeBacklinkSource({
      host, source: "verify", ok: null,
      referring_domains: null, backlinks: null, linked_pages: null, crawl_pages: null,
      checked: 0, live: null, followed: null,
      confidence: CONFIDENCE.verify,
      note:
        "nothing named a page that links here, so there was nothing to go and " +
        "look at. This crawler verifies claims; it does not go hunting.",
      error: null,
    });
    writeBacklinkRows(host, "verify", [], MAX_ROWS);
  } else {
    const checked = [];
    for (const url of candidates) {
      if (Date.now() >= deadline) break;
      checked.push(await verifyLink(url, host, paces.verify));
    }
    const readable = checked.filter((c) => c.live !== null);
    const live = readable.filter((c) => c.live === true);
    const followed = live.filter((c) => c.nofollow === false);
    const fromHosts = new Set<string>();
    for (const c of live) {
      try {
        const from = registrable(new URL(c.url).hostname);
        if (from && from !== host && !from.endsWith(`.${host}`)) fromHosts.add(from);
      } catch {
        /* a url we fetched but cannot re-parse contributes no host */
      }
    }

    writeBacklinkSource({
      host,
      source: "verify",
      ok: readable.length ? 1 : 0,
      // Counted from pages THIS BOX fetched and read — 0.95 against Bing's
      // 0.70, and it is the same measurement made better.
      referring_domains: live.length ? fromHosts.size : null,
      backlinks: null,
      linked_pages: null,
      crawl_pages: null,
      checked: checked.length,
      live: readable.length ? live.length : null,
      followed: live.length ? followed.length : null,
      confidence: CONFIDENCE.verify,
      note: readable.length
        ? `${live.length} of ${readable.length} readable page(s) still carried the link; ` +
          `${followed.length} of those pass authority. ` +
          (checked.length - readable.length
            ? `${checked.length - readable.length} could not be read at all — a WAF or a timeout is not a removed link.`
            : "")
        : null,
      error: readable.length
        ? null
        : `${checked.length} page(s) were fetched and none could be read`,
    });
    if (readable.length) {
      answered = true;
      record(`backlinks.${host}.liveLinks`, live.length, { source: "verify", of: readable.length });
    }

    writeBacklinkRows(
      host,
      "verify",
      checked.map((c) => {
        let from = "";
        try {
          from = registrable(new URL(c.url).hostname);
        } catch {
          from = "";
        }
        return {
          from_domain: from,
          from_url: c.url,
          to_url: c.to,
          anchor: c.anchor,
          live: c.live === null ? null : c.live ? 1 : 0,
          nofollow: c.nofollow === null ? null : c.nofollow ? 1 : 0,
          error: c.error,
        };
      }),
      MAX_ROWS,
    );
  }

  return answered;
}
