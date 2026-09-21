import { createHash } from "node:crypto";
import { db, ventureRows } from "../db.ts";
import { dashboardAlerts } from "../integrations/proactive/dashboard-alerts.ts";
import { inboxItems } from "../routes/actionInbox.ts";
import { linkedEntities } from "../integrations/ventures/links.ts";
import { hostMatch, ventureForHost } from "../shared/host.ts";
import { registerBoardSource, type BoardCandidate } from "./automation.ts";
import { judgeSearchIntent, queryKey, QUERIES_JUDGED_PER_SWEEP } from "./brand-query.ts";

/** Stored, actionable work; inboxItems owns acknowledgement/snooze decisions. */
export function inboxCandidates(): BoardCandidate[] {
  const recent = Date.now() - 7 * 86_400_000;
  return inboxItems().filter(item => item.source !== "Alert" &&
    (!["Revenue", "Failed job"].includes(item.source) || Date.parse(item.at) >= recent))
    .map(item => {
      let title = item.title;
      if (item.source === "Email") {
        title = item.detail ? `Reply needed: ${item.detail}` : "Review an email awaiting your reply";
        const [, account, ...thread] = item.id.split(":");
        const metadata = db.prepare("SELECT subject,from_name,from_address FROM mailflow_triage_threads WHERE account_id=? AND thread_id=?")
          .get(Number(account), thread.join(":")) as { subject: string; from_name: string; from_address: string } | undefined;
        if (metadata) title = `Reply to ${metadata.from_name || metadata.from_address || "email"}${metadata.subject ? `: ${metadata.subject}` : ""}`;
      }
      return { origin: `inbox:${item.id}`, title, detail: item.detail || `Review this ${item.source.toLowerCase()}.`,
        href: item.href, observedAt: item.at, ventureId: item.venture, urgency: item.priority === 1 ? 3 : 1 };
    });
}

export async function healthCandidates(): Promise<BoardCandidate[]> {
  const doc = await dashboardAlerts();
  const ventures = ventureRows();
  // Read the latest decision, including an acknowledged event, so a covered
  // seed rule's snooze/ack also applies to its individual live health cards.
  const events = db.prepare(`SELECT e.id,e.rule_id,e.acknowledged_at,s.resolved_at,s.snoozed_until,r.seeded,r.skill,r.path
    FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY rule_id ORDER BY ts DESC,id DESC) AS rank FROM alert_events WHERE cleared_at IS NULL AND kind IN ('trip','unreadable')) e
    JOIN alert_rules r ON r.id=e.rule_id LEFT JOIN action_inbox_state s ON s.id='alert:'||e.id WHERE e.rank=1`).all() as {
      id: number; rule_id: number; acknowledged_at: string | null; resolved_at: string | null; snoozed_until: string | null;
      seeded: number; skill: string; path: string;
    }[];
  type EventIdentity = Pick<(typeof events)[number], "id" | "rule_id" | "seeded" | "skill" | "path">;
  const matches = (id: string, e: EventIdentity) => id === `rule:${e.rule_id}` || (e.seeded && (
    (e.skill === "fleet" && e.path === "totals.fullestDisk.percent" && /^fleet:.*:disk:/.test(id)) ||
    (e.skill === "domains" && e.path === "summary.expiring30" && id.startsWith("domain:")) ||
    (e.skill === "uptime" && e.path === "summary.down" && id.startsWith("uptime:") && id.endsWith(":down"))));
  const matchingEvents = (id: string) => events.filter(e => matches(id, e));
  // A rule can produce a new event ID after its earlier event was filed.
  // Latest events decide visibility; older filed events still prove identity.
  // Historical portfolio summaries do not identify individual hosts/domains:
  // a new affected entity must not be hidden by an old aggregate alert.
  const filedEvents = db.prepare(`SELECT e.id,e.rule_id,r.seeded,r.skill,r.path
    FROM alert_events e JOIN alert_rules r ON r.id=e.rule_id
    WHERE EXISTS (SELECT 1 FROM board_cards b WHERE b.origin='inbox:alert:'||e.id)
       OR EXISTS (SELECT 1 FROM board_automation_filings f WHERE f.origin='inbox:alert:'||e.id)`).all() as EventIdentity[];
  return doc.alerts.filter(a => a.actionable !== false && !a.id.startsWith("source:") &&
    !matchingEvents(a.id).some(e => e.acknowledged_at || e.resolved_at || (e.snoozed_until && Date.parse(e.snoozed_until) > Date.now())))
    .map(a => ({ origin: `health:${a.id}`, aliases: [...new Set([...matchingEvents(a.id), ...filedEvents.filter(e => a.id === `rule:${e.rule_id}`)].map(e => `inbox:alert:${e.id}`))], title: a.title, detail: a.detail || "Review the current health reading.",
      href: a.href ?? (a.sources.includes("fleet") ? "/dashboards/servers" : a.sources.includes("domains") ? "/dashboards/domains" : "/alerts"),
      observedAt: doc.asOf, ventureId: a.ventureId ?? (a.entity && a.entity.kind !== "server" ? ventureForHost(a.entity.id, ventures)?.id : null), urgency: a.severity === "critical" ? 3 : 2 }));
}

/** One measured search opportunity per venture, at most six per pass. No
 * missing-plugin guesses and no forecasts. Explicit links precede host joins.
 *
 * Brand and navigational rows are skipped: a query that names a venture (or
 * misspells it, or adds `github`/`login` to it) is somebody who already knew
 * the name, and "improve the page targeting it" is not work anybody can do.
 * That reading is a model's — see `brand-query.ts` for why a spelling
 * comparison could not do it — and it is asked ONCE for the whole sweep, with
 * every launched venture's names as context. Judging per venture would both
 * cost a round trip per query and hide the cross-venture case that filed a card
 * under the wrong venture ("neu.ie: improve the page targeting 'freellmapi'").
 *
 * Rows are read impressions-first and the highest-impression `need` row wins,
 * so a property whose whole head is brand simply yields nothing.
 *
 * NO MODEL, NO CARDS. A sweep whose judgment came back `unjudged` files nothing
 * from search and lets the next sweep try; the rows are stored, so nothing is
 * lost, while a wrongly filed card is filed for good — see `judgeSearchIntent`. */
export async function growthCandidates(): Promise<BoardCandidate[]> {
  const cutoff = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const sites = db.prepare("SELECT property,window_start,window_end,seen_at FROM gsc_sites WHERE error IS NULL AND window_start IS NOT NULL AND window_end IS NOT NULL AND seen_at>=?").all(cutoff) as {
    property: string; window_start: string; window_end: string; seen_at: string;
  }[];
  const candidates: (BoardCandidate & { score: number })[] = [];
  const ventures = ventureRows();
  const brands = ventures.filter(v => v.stage === "launched")
    .map(v => ({ name: v.name, slug: v.slug, host: v.host }));
  type Measured = {
    query: string; impressions: number; clicks: number; position: number; seen_at: string;
    window_start: string; window_end: string;
  };
  /* Every venture's measured rows, impressions first, one entry per query: the
     pool the single judgment is drawn from and the order the winner is picked
     in. A query measured on two of a venture's properties is one question. */
  const pools: { venture: (typeof ventures)[number]; rows: Measured[] }[] = [];
  for (const v of ventures) {
    if (v.stage !== "launched" || (db.prepare("SELECT proposals FROM synthesis_venture_prefs WHERE venture_id=?").get(v.id) as { proposals: number } | undefined)?.proposals === 0) continue;
    const links = linkedEntities(v.id, "gsc");
    const owned = sites.filter(s => Date.parse(s.window_end) >= Date.now() - 7 * 86_400_000 &&
      (links.length ? links.includes(s.property) : !!v.host && hostMatch(s.property, v.host) && ventureForHost(v.host, ventures)?.id === v.id));
    const rows: Measured[] = [];
    for (const site of owned) {
      rows.push(...(db.prepare("SELECT query,impressions,clicks,position,seen_at FROM gsc_queries WHERE property=? AND seen_at>=? AND impressions>=100 AND position>=5 AND position<=20 ORDER BY impressions DESC,query LIMIT 25")
        .all(site.property, cutoff) as Omit<Measured, "window_start" | "window_end">[])
        .map(row => ({ ...row, window_start: site.window_start, window_end: site.window_end })));
    }
    const seen = new Set<string>();
    const ordered = rows.sort((a, b) => b.impressions - a.impressions || a.query.localeCompare(b.query))
      .filter(row => { const key = queryKey(row.query); if (!key || seen.has(key)) return false; seen.add(key); return true; });
    if (ordered.length) pools.push({ venture: v, rows: ordered });
  }

  /* ONE BATCH FOR THE SWEEP, INTERLEAVED. The judge caps how many queries a
     single reply may cover, and that allowance is spent a row at a time across
     the ventures rather than head-first: a portfolio's biggest property would
     otherwise fill the batch with its own brand head and leave every smaller
     venture unjudged, which is the one property the old per-venture scan had. */
  const asked: string[] = [];
  for (let depth = 0; asked.length < QUERIES_JUDGED_PER_SWEEP; depth++) {
    const round = pools.map(pool => pool.rows[depth]).filter((row): row is Measured => !!row);
    if (!round.length) break;
    for (const row of round) {
      if (asked.length >= QUERIES_JUDGED_PER_SWEEP) break;
      asked.push(row.query);
    }
  }
  const intent = await judgeSearchIntent(asked, brands);

  for (const { venture: v, rows } of pools) {
    /* Anything past the batch cap is absent from the map, and absent is not
       `need`: an unasked query is no more filed than an unjudged one. */
    const query = rows.find(row => intent.get(queryKey(row.query)) === "need");
    if (!query) continue;
    candidates.push({ origin: `growth:search:${v.id}:${createHash("sha256").update(query.query.toLowerCase()).digest("hex").slice(0, 24)}`,
      title: `${v.name}: improve the page targeting “${query.query}”`,
      detail: `Review the page and search intent for “${query.query}”. It received ${query.impressions.toLocaleString("en")} impressions and ${query.clicks.toLocaleString("en")} clicks at average position ${query.position.toFixed(1)} during ${query.window_start}–${query.window_end}.\n\nCompare the pages ranking above it, then improve the title and content where relevant. This is a proposal based on Search Console's returned query rows, not a forecast of extra revenue.`,
      href: `/ventures/${v.slug}`, observedAt: query.seen_at, ventureId: v.id, urgency: 1, score: query.impressions });
  }
  return candidates.sort((a, b) => b.score - a.score || a.origin.localeCompare(b.origin)).slice(0, 6);
}

export function registerBuiltinBoardSources() {
  registerBoardSource({ id: "health", label: "Live server, domain and app issues", read: healthCandidates });
  registerBoardSource({ id: "inbox", label: "Commitments, replies and recent failed work", read: inboxCandidates });
  registerBoardSource({ id: "growth", label: "Growth opportunities", read: growthCandidates });
}
