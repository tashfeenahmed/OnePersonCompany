/**
 * WHAT THIS BOX ALREADY KNOWS, put in front of the run before it starts.
 *
 * A run that had to discover the audit, the backlinks and the presence matrix
 * for itself would spend half its budget re-fetching documents that are three
 * feet away, and a run answered by a RAW PROVIDER — no tools, no web — could
 * not fetch them at all and would answer out of its own head. So the brief
 * carries the data. That is the difference between this and the chat route's
 * `withSkills`, which deliberately tells an agent only where the data is: chat
 * is a conversation that can ask a second question, a run gets one turn.
 *
 * IT READS OVER LOOPBACK, not by importing four areas' modules. The routes are
 * the published shape of each of those documents, they are already the thing
 * the skills proxy serves, and an import would make this file break whenever
 * one of them changed a function name — while the HTTP shape is the one every
 * other reader on this box depends on and therefore the one that is kept
 * stable. It costs a millisecond on the same interface the browser uses.
 *
 * EVERY BLOCK IS TRIMMED AND SAYS SO. The audit alone is forty kilobytes of
 * JSON, most of it a per-page table nothing in a brief needs. A block that ran
 * over its budget ends with the line saying how much was cut, because a model
 * handed a truncated list and not told it was truncated will report the last
 * item as the last item.
 *
 * A SOURCE THAT FAILS IS NAMED, NOT DROPPED. `presence: could not be read`
 * beats presence quietly missing, for the reason every rule on every skill
 * here gives: absent data read as absent evidence is the mistake this whole
 * dashboard is built to avoid.
 */
import { PORT } from "../../config.ts";
import { db, type VentureRow } from "../../db.ts";
import { pastRuns, type RunRow } from "./store.ts";

const BASE = `http://127.0.0.1:${PORT}`;

/** A block of the brief: what it is, and the text. */
export type Block = { source: string; text: string };

/** Longest any one block may be. Six of these is around eighteen thousand
 *  characters, which is a few thousand tokens — a fraction of a context and
 *  far less than the run would spend fetching them itself. */
const BLOCK_CAP = 3_000;

function trim(text: string, cap = BLOCK_CAP): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… trimmed here: ${text.length - cap} more characters of this document were not included.`;
}

async function get<T>(path: string): Promise<T | { error: string }> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const doc = (await res.json().catch(() => null)) as T | null;
    if (!res.ok)
      return {
        error: `${path} answered ${res.status}${
          doc && typeof doc === "object" && "error" in (doc as Record<string, unknown>)
            ? ` — ${String((doc as Record<string, unknown>).error)}`
            : ""
        }`,
      };
    if (doc === null) return { error: `${path} did not answer JSON.` };
    return doc;
  } catch (err) {
    return { error: `${path} could not be read — ${err instanceof Error ? err.message : String(err)}` };
  }
}

const failed = (v: unknown): v is { error: string } =>
  typeof v === "object" && v !== null && "error" in v && typeof (v as { error: unknown }).error === "string";

/* ------------------------------------------------------------- the blocks */

/**
 * The latest audit, as the four sentences a brief can use.
 *
 * The per-page table is dropped entirely. A finding already names the pages it
 * is about and the count of them; sixty rows of title lengths is the raw
 * material the findings were computed FROM, and a brief that carried it would
 * be inviting the model to recompute them worse.
 */
export async function auditBlock(v: VentureRow): Promise<Block> {
  type Doc = {
    ts: string;
    summary: { pages: number; errors: number; warnings: number; notices: number };
    https: { httpRedirectsToHttps: boolean | null; note: string };
    sitemap: { found: string | null; urls: number | null };
    canonicalHost: { requested: string; answered: string | null };
    crawl: { reached: number; queuedButNotReached: number; stoppedBecause: string };
    findings: { severity: string; code: string; what: string; count: number; evidence: string }[];
    links: { checked: number; broken: { url: string; status: number }[] };
    search: { property: string | null; ranked: { page: string; impressions: number; issues: string[] }[] };
  };
  const doc = await get<Doc>(`/api/audit/${v.slug}`);
  if (failed(doc)) return { source: "SEO audit", text: doc.error };

  const lines = [
    `Crawled ${doc.ts}. ${doc.summary.pages} pages reached, ${doc.crawl.queuedButNotReached} queued and not reached (${doc.crawl.stoppedBecause}).`,
    `Findings: ${doc.summary.errors} errors, ${doc.summary.warnings} warnings, ${doc.summary.notices} notices. There is no score and you must not invent one.`,
    `https: ${doc.https.note}`,
    `sitemap: ${doc.sitemap.found ? `${doc.sitemap.found} (${doc.sitemap.urls ?? "unknown"} urls)` : "none found"}`,
    `canonical host: requested ${doc.canonicalHost.requested}, answered ${doc.canonicalHost.answered ?? "unknown"}`,
    `links checked ${doc.links.checked}, broken ${doc.links.broken.length}${doc.links.broken.length ? `: ${doc.links.broken.slice(0, 8).map((b) => `${b.url} (${b.status})`).join(", ")}` : ""}`,
    ``,
    `Every finding, worst first — severity, code, how many pages, and what it was computed from:`,
    ...doc.findings.map((f) => `- [${f.severity}] ${f.code} ×${f.count} — ${f.what} (evidence: ${f.evidence})`),
  ];
  if (doc.search.property)
    lines.push(
      ``,
      `Search Console property ${doc.search.property}. Pages Google actually shows that this crawl found faults on, by impressions (Search Console's figures over ITS window, not this crawl's):`,
      ...doc.search.ranked.slice(0, 10).map((r) => `- ${r.page} — ${r.impressions} impressions — ${r.issues.join("; ")}`),
    );
  return { source: "SEO audit (this box crawled the site)", text: trim(lines.join("\n"), 4_500) };
}

export async function presenceBlock(v: VentureRow): Promise<Block> {
  type Doc = {
    products: {
      product: string;
      host: string | null;
      sources: { source: string; status: string; url: string | null; note: string | null }[];
    }[];
  };
  const doc = await get<Doc>("/api/presence");
  if (failed(doc)) return { source: "Presence", text: doc.error };
  const mine = doc.products.filter(
    (p) => (v.host && p.host === v.host) || p.product.toLowerCase() === v.name.toLowerCase(),
  );
  if (!mine.length)
    return { source: "Presence", text: `Nothing on the presence matrix is for ${v.name}. That means it is not on the watch list, not that it is listed nowhere.` };
  const lines = mine.flatMap((p) => [
    `${p.product} (${p.host ?? "no host"}):`,
    ...p.sources.map((s) => `  - ${s.source}: ${s.status}${s.url ? ` ${s.url}` : ""}${s.note ? ` — ${s.note}` : ""}`),
  ]);
  lines.push(
    ``,
    `\`blocked\` is NOT \`absent\`: it means the source could not be asked. Report it as not checked.`,
  );
  return { source: "Presence — where it exists on somebody else's site", text: trim(lines.join("\n")) };
}

export async function backlinksBlock(v: VentureRow): Promise<Block> {
  type Doc = {
    hosts: {
      host: string;
      sources: {
        source: string;
        confidence: number;
        ok: boolean | null;
        referringDomains: number | null;
        backlinks: number | null;
        crawlPages: number | null;
      }[];
    }[];
  };
  const doc = await get<Doc>("/api/backlinks");
  if (failed(doc)) return { source: "Backlinks", text: doc.error };
  const mine = doc.hosts.filter((h) => v.host && h.host === v.host);
  if (!mine.length)
    return { source: "Backlinks", text: `No backlink row for ${v.host ?? v.name}. It is not on the list, which is not evidence about its links.` };
  const lines = mine.flatMap((h) => [
    `${h.host}:`,
    ...h.sources.map(
      (s) =>
        `  - ${s.source} (confidence ${s.confidence}): ok=${s.ok === null ? "never asked" : s.ok}, referring domains ${s.referringDomains ?? "null"}, backlinks ${s.backlinks ?? "null"}, crawl pages ${s.crawlPages ?? "null"}`,
    ),
  ]);
  lines.push(
    ``,
    `NEVER add two sources together — they overlap and disagree by design. Quote a number with the source that said it.`,
  );
  return { source: "Backlinks", text: trim(lines.join("\n")) };
}

export async function demandBlock(): Promise<Block> {
  type Doc = {
    windowDays: number;
    terms: string[];
    reddit?: { connected: boolean; signals?: { term?: string; title: string; score?: number | null; url?: string }[] };
    hn?: { connected: boolean; signals?: { term?: string; title: string; points?: number | null; url?: string }[] };
    queries?: { term: string; source: string; outcome: string; note?: string | null }[];
  };
  const doc = await get<Doc>("/api/demand");
  if (failed(doc)) return { source: "Demand", text: doc.error };
  const lines = [
    `Window ${doc.windowDays} days. Watch phrases: ${doc.terms.join(", ") || "none"}.`,
    `Thread counts span the sources; UPVOTES ARE NEVER ADDED across Reddit and Hacker News.`,
    ``,
    `Reddit threads:`,
    ...(doc.reddit?.signals ?? []).slice(0, 25).map((s) => `- ${s.term ? `[${s.term}] ` : ""}${s.title}${s.score === null || s.score === undefined ? "" : ` (${s.score})`}${s.url ? ` ${s.url}` : ""}`),
    ``,
    `Hacker News threads:`,
    ...(doc.hn?.signals ?? []).slice(0, 25).map((s) => `- ${s.term ? `[${s.term}] ` : ""}${s.title}${s.points === null || s.points === undefined ? "" : ` (${s.points} points)`}${s.url ? ` ${s.url}` : ""}`),
  ];
  const skipped = (doc.queries ?? []).filter((q) => q.outcome !== "ok");
  if (skipped.length)
    lines.push(
      ``,
      `Phrases nobody would let us ask, or that failed — these are NOT evidence that nobody is talking about them:`,
      ...skipped.slice(0, 15).map((q) => `- ${q.term} via ${q.source}: ${q.outcome}${q.note ? ` — ${q.note}` : ""}`),
    );
  return { source: "Demand — Reddit, Hacker News, the search node", text: trim(lines.join("\n"), 4_000) };
}

export async function searchConsoleBlock(v: VentureRow): Promise<Block> {
  type Doc = {
    connected: boolean;
    window?: { days: number; start: string; end: string; lagNote?: string };
    properties?: { property?: string; site?: string; clicks?: number; impressions?: number; position?: number | null }[];
  };
  const doc = await get<Doc>("/api/gsc");
  if (failed(doc)) return { source: "Search Console", text: doc.error };
  if (!doc.connected) return { source: "Search Console", text: "Not connected. Nothing Google reported is available." };
  const host = v.host ?? "";
  const props = (doc.properties ?? []).filter((p) => {
    const name = String(p.property ?? p.site ?? "");
    return host && name.toLowerCase().includes(host.toLowerCase());
  });
  const lines = [
    `Window ${doc.window?.start} to ${doc.window?.end} (${doc.window?.days} days).${doc.window?.lagNote ? ` ${doc.window.lagNote}` : ""}`,
    props.length
      ? props
          .map((p) => `- ${p.property ?? p.site}: ${p.clicks ?? "null"} clicks, ${p.impressions ?? "null"} impressions, position ${p.position ?? "null"}`)
          .join("\n")
      : `No Search Console property on this box matches ${host || v.name}. That is a missing link, not a site with no traffic.`,
  ];
  return { source: "Search Console", text: trim(lines.join("\n"), 1_800) };
}

export async function bingBlock(v: VentureRow): Promise<Block> {
  type Doc = { connected: boolean; sites?: { site?: string; url?: string; clicks?: number; impressions?: number; crawled?: number | null; indexed?: number | null }[] };
  const doc = await get<Doc>("/api/bing");
  if (failed(doc)) return { source: "Bing Webmaster", text: doc.error };
  if (!doc.connected) return { source: "Bing Webmaster", text: "Not connected. Nothing Bing reported is available." };
  const host = v.host ?? "";
  const sites = (doc.sites ?? []).filter((s) => host && String(s.site ?? s.url ?? "").toLowerCase().includes(host.toLowerCase()));
  return {
    source: "Bing Webmaster",
    text: trim(
      sites.length
        ? sites
            .map((s) => `- ${s.site ?? s.url}: ${s.clicks ?? "null"} clicks, ${s.impressions ?? "null"} impressions, crawled ${s.crawled ?? "null"}, indexed ${s.indexed ?? "null"}`)
            .join("\n")
        : `No Bing site on this box matches ${host || v.name}.`,
      1_800,
    ),
  };
}

/** The rivals already on file. This is the block that makes a competitor sweep
 *  the second one rather than the first: it is handed what is known so it can
 *  verify and extend instead of starting again. */
export function competitorBlock(v: VentureRow): Block {
  const rows = db
    .prepare(
      "SELECT name, url, positioning, pricing, strengths, weaknesses, last_verified, first_seen FROM competitor_profiles WHERE venture_id = ? ORDER BY last_verified DESC",
    )
    .all(v.id) as unknown as {
    name: string;
    url: string | null;
    positioning: string | null;
    pricing: string | null;
    strengths: string;
    weaknesses: string;
    last_verified: string;
    first_seen: string;
  }[];
  if (!rows.length)
    return { source: "Competitor profiles on file", text: "None. This is the first sweep for this venture." };
  const list = (raw: string) => {
    try {
      const p = JSON.parse(raw) as unknown;
      return Array.isArray(p) ? (p as string[]).join("; ") : "";
    } catch {
      return "";
    }
  };
  return {
    source: "Competitor profiles on file",
    text: trim(
      rows
        .map(
          (r) =>
            `- ${r.name}${r.url ? ` (${r.url})` : ""} — positioning: ${r.positioning ?? "unknown"} — pricing: ${r.pricing ?? "unknown"} — strengths: ${list(r.strengths) || "none recorded"} — weaknesses: ${list(r.weaknesses) || "none recorded"} — last verified ${r.last_verified}, first seen ${r.first_seen}`,
        )
        .join("\n"),
      4_000,
    ),
  };
}

/** What has already been said about this venture in this kind of run. Dates
 *  and titles only — the whole report is what the new run is for. */
export function historyBlock(kind: string, ventureId: string | null): Block {
  const rows: RunRow[] = pastRuns(kind, ventureId);
  if (!rows.length) return { source: `Past ${kind} runs`, text: "None. This is the first one." };
  return {
    source: `Past ${kind} runs for this venture`,
    text: rows.map((r) => `- ${r.finished_at ?? r.queued_at} — ${r.title} (${r.output_chars} characters, by ${r.backend ?? "unknown"})`).join("\n"),
  };
}

/** The venture record, in the words the owner and the form used. The stage
 *  arrives with the sentence that defines it, for routes/chat.ts's reason:
 *  "pre-launch" means something precise to the owner who picked it off a form
 *  that explained it, and nothing in particular to a model. */
export function ventureBlock(v: VentureRow, stageMeans: string): Block {
  const lines = [
    `Name: ${v.name}`,
    `Stage: ${v.stage} — ${stageMeans}`,
    `Website: ${v.website ?? "none recorded"}${v.host ? ` (host ${v.host})` : ""}`,
    `What the owner says it is: ${v.description || "nothing written down"}`,
  ];
  return { source: "The venture record", text: lines.join("\n") };
}

/** The blocks, rendered as the part of the system turn that is DATA rather
 *  than instruction, each one labelled with where it came from so a report can
 *  say so. */
export function renderBlocks(blocks: Block[]): string {
  return blocks
    .map((b) => `--- ${b.source} ---\n${b.text}`)
    .join("\n\n");
}
