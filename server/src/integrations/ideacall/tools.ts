/**
 * WHAT THE IDEA CALL CAN DO WHILE IT TALKS.
 *
 * Two kinds of tool, and the difference matters to the person on the call.
 * The first five LOOK — the web, one page, the domain registries, who ranks
 * for a phrase, what is in the App Store — and every one of them is venture-
 * free, because an idea has no site, no Search Console property and no app to
 * be measured through. The last three WRITE, and they write into the idea page
 * the owner is about to go back to: the plan's fields, the alternatives, the
 * name shortlist.
 *
 * NOT THE SKILLS REGISTRY. The chat's tool loop (integrations/runtime/loop.ts)
 * publishes every skill on the box, which is the right surface for a Chief of
 * Staff and the wrong one for a call about one idea: eight tools the model can
 * hold in its head beat ninety it has to search. The wire helpers are shared;
 * the catalog is this file.
 *
 * EVERY RESULT IS TEXT, CAPPED. A tool that returned a 200 kB page would spend
 * the turn's whole budget on one read.
 */
import { db, type VentureRow } from "../../db.ts";
import * as searxng from "../../providers/searxng.ts";
import * as instance from "../../searxng/instance.ts";
import { fetchHtml, readPage } from "../growth/pages.ts";
import { searchAccounts, searchBatch, SearchBusy } from "../domain-search/service.ts";
import { PROFILE_FIELDS, type JourneyCommand } from "../../../../shared/ventureJourney.ts";
import { readJourney, writeJourneyCommand } from "../ventures/journey.ts";
import { knownRivals, writeRegistry } from "../runs/competitors.ts";
import { hostOf, mergeRegistry, type Found } from "../runs/competitorsMerge.ts";

const RESULT_CHARS = 6000;
const PAGE_CHARS = 5000;
const TOOL_MS = 25_000;

/** The six fields the idea page's plan card shows — see FIELDS.idea in
 *  client/src/components/ventures/journey/VentureJourney.tsx. */
export const IDEA_FIELDS = ["customer", "problem", "promise", "revenueModel", "experiment", "successMeasure"] as const;
export type IdeaField = typeof IDEA_FIELDS[number];

/** What a turn wrote, in the idea page's own words — the call shows it. */
export type IdeaUpdate = { fields: string[]; competitors: string[]; names: string[] };
export const emptyUpdate = (): IdeaUpdate => ({ fields: [], competitors: [], names: [] });

const str = { type: "string" } as const;
const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[]) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

export const TOOLS: unknown[] = [
  fn("web_search", "Search the web. Use it to find existing companies, what people complain about, prices, and whether the gap is real.", { query: str }, ["query"]),
  fn("read_page", "Read one web page as text: a competitor's home or pricing page, a forum thread, an article.", { url: str }, ["url"]),
  fn("check_domains", "Check whether domain names can be registered. Up to 10 full names such as tripvote.com.", { domains: { type: "array", items: str, maxItems: 10 } }, ["domains"]),
  fn("seo_check", "Who ranks for a search phrase today and how strong those pages are: titles, domains, word counts. Tells you how hard the phrase is to win.", { keyword: str }, ["keyword"]),
  fn("app_store_check", "Search the App Store for a phrase: the apps there, who makes them, their ratings and prices. Use for anything that could be a mobile app.", { keyword: str }, ["keyword"]),
  fn("update_idea", "Write what has been settled into the idea page. Send only the fields you are changing; each replaces what was there. Call it as soon as something is settled, not at the end.", {
    description: { type: "string", description: "One or two plain sentences saying what this is and who it is for." },
    customer: { type: "string", description: PROFILE_FIELDS.customer },
    problem: { type: "string", description: PROFILE_FIELDS.problem },
    promise: { type: "string", description: PROFILE_FIELDS.promise },
    revenueModel: { type: "string", description: PROFILE_FIELDS.revenueModel },
    experiment: { type: "string", description: PROFILE_FIELDS.experiment },
    successMeasure: { type: "string", description: PROFILE_FIELDS.successMeasure },
  }, []),
  fn("save_competitors", "Record existing companies or products the owner would be compared with. Only ones you have actually seen in a search or on a page, with their real website.", {
    competitors: { type: "array", maxItems: 8, items: { type: "object", required: ["name", "url"], properties: {
      name: str, url: str,
      positioning: { type: "string", description: "What they say they are, in a sentence." },
      pricing: { type: "string", description: "What it costs, if you saw it. Leave out if you did not." },
      strengths: { type: "array", items: str, maxItems: 4 }, weaknesses: { type: "array", items: str, maxItems: 4 },
    } } },
  }, ["competitors"]),
  fn("save_name", "Put a name on the idea page's shortlist, with its domain and what you found about it.", {
    name: str, domain: str, status: { type: "string", enum: ["shortlisted", "ruled-out"] },
    evidence: { type: "string", description: "Why: domain available, no app by that name, a company already uses it…" },
  }, ["name", "domain", "status", "evidence"]),
];

/** What the caption under the orb says while a tool runs. */
export function toolLabel(name: string, args: Record<string, unknown>): string {
  const host = (raw: unknown) => { try { return new URL(String(raw)).host.replace(/^www\./, ""); } catch { return "a page"; } };
  switch (name) {
    case "web_search": return "Searching the web";
    case "read_page": return `Reading ${host(args.url)}`;
    case "check_domains": return "Checking domains";
    case "seo_check": return "Checking who ranks";
    case "app_store_check": return "Searching the App Store";
    case "update_idea": return "Writing it down";
    case "save_competitors": return "Noting the alternatives";
    case "save_name": return "Shortlisting a name";
    default: return "Working";
  }
}

const cap = (text: string, max = RESULT_CHARS) => text.length > max ? `${text.slice(0, max)}\n…(cut)` : text;
const words = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : "";
/** A model asked for a price it did not see writes "Not mentioned". That is an
 *  absence, and the page draws an absence as nothing. */
const known = (v: unknown, max: number) => { const text = words(v, max); return /^(none|n\/?a|unknown|not (mentioned|found|available|stated|listed|specified|clear|sure)|unclear|tbd|-+)\.?$/i.test(text) ? "" : text; };
const list = (v: unknown, n: number, max: number) => Array.isArray(v) ? v.map(item => words(item, max)).filter(Boolean).slice(0, n) : [];

async function search(query: string) {
  const url = searxng.endpoint();
  if (searxng.mode() === "managed" && searxng.isLoopback(url) && !instance.isRunning()) throw new Error("Web search is not running on this box (SearXNG is stopped).");
  const borrowed = searxng.borrowKey("idea_call");
  if (!borrowed) throw new Error("Web search is not connected on this box.");
  return searxng.ask(borrowed.url, borrowed.key, { query }, TOOL_MS);
}

async function webSearch(args: Record<string, unknown>): Promise<string> {
  const query = words(args.query, 300);
  if (!query) return "Nothing to search for.";
  const answer = await search(query);
  if (!answer.results.length) return `No results for "${query}".`;
  return answer.results.slice(0, 8).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.content ?? "").slice(0, 260)}`).join("\n");
}

const stripTags = (html: string) => html
  .replace(/<(script|style|noscript|svg|nav|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
  .replace(/\s+/g, " ").trim();

async function readOnePage(args: Record<string, unknown>): Promise<string> {
  let url = words(args.url, 500);
  if (!url) return "No address given.";
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const got = await fetchHtml(url);
  if ("error" in got) return `Could not read ${url}: ${got.error}`;
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(got.html)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
  return cap(`${title}\n${got.url}\n\n${stripTags(got.html)}`, PAGE_CHARS);
}

/** RDAP, for a box with no registrar connected. A registry that answers 404
 *  has no such registration; anything else but a 200 is "could not tell". */
async function rdap(domain: string, signal: AbortSignal): Promise<string> {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { signal, redirect: "follow", /* A named agent: rdap.org answers 403 to a client that does not say who it is. */
      headers: { accept: "application/rdap+json", "user-agent": "OnePersonCompany/1.0 (domain availability check)" } });
    return res.status === 404 ? "looks available (no registration found)" : res.ok ? "taken (already registered)" : "could not tell";
  } catch { return "could not tell"; }
}

async function checkDomains(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const names = [...new Set(list(args.domains, 10, 253).map(n => n.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")))]
    .filter(n => /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(n));
  if (!names.length) return "No valid domain names given. Send full names such as tripvote.com.";
  const account = searchAccounts()[0];
  if (account) {
    const batch = names.slice(0, account.batchSize);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const results = await searchBatch(account.id, batch, signal);
        return results.map(r => `${r.domain}: ${r.status}${r.premium ? " (premium price)" : ""}${r.note ? ` — ${r.note}` : ""}`).join("\n") + `\n(checked with ${account.name})`;
      } catch (err) {
        if (!(err instanceof SearchBusy) || attempt) break;
        await new Promise(resolve => setTimeout(resolve, 1300));
      }
    }
  }
  const lines = await Promise.all(names.map(async n => `${n}: ${await rdap(n, signal)}`));
  return `${lines.join("\n")}\n(from the public registry records; a registrar may still price or reserve a name)`;
}

async function seoCheck(args: Record<string, unknown>): Promise<string> {
  const keyword = words(args.keyword, 200);
  if (!keyword) return "No phrase given.";
  const answer = await search(keyword);
  const top = answer.results.slice(0, 5);
  if (!top.length) return `Nobody ranks for "${keyword}" in the engines this box can ask — the phrase may be too rare to measure.`;
  const pages = await Promise.all(top.slice(0, 3).map(r => readPage(r.url).catch(() => null)));
  const rows = top.map((r, i) => {
    const page = pages[i];
    const depth = page && !page.error ? ` — ${page.words} words, ${page.h2.length} sections${page.schema.length ? `, schema: ${page.schema.slice(0, 3).join("/")}` : ""}` : "";
    return `${i + 1}. ${hostOf(r.url) ?? r.url} — ${r.title}${depth}`;
  });
  const hosts = new Set(top.map(r => hostOf(r.url)));
  return `Top results for "${keyword}":\n${rows.join("\n")}\n${hosts.size} different sites in the top ${top.length}. Big brands and long pages mean a hard phrase; forums, thin pages and small sites mean an open one.`;
}

async function appStoreCheck(args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const keyword = words(args.keyword, 120);
  if (!keyword) return "No phrase given.";
  const res = await fetch(`https://itunes.apple.com/search?limit=8&entity=software&term=${encodeURIComponent(keyword)}`, { signal });
  if (!res.ok) return `The App Store search did not answer (${res.status}).`;
  const doc = await res.json() as { results?: { trackName?: string; sellerName?: string; averageUserRating?: number; userRatingCount?: number; formattedPrice?: string; primaryGenreName?: string; trackViewUrl?: string; releaseDate?: string }[] };
  const apps = doc.results ?? [];
  if (!apps.length) return `No App Store apps for "${keyword}".`;
  return `App Store results for "${keyword}":\n` + apps.map((a, i) =>
    `${i + 1}. ${a.trackName} — ${a.sellerName}; ${a.userRatingCount ?? 0} ratings${a.averageUserRating ? ` at ${a.averageUserRating.toFixed(1)}` : ""}; ${a.formattedPrice ?? "?"}; ${a.primaryGenreName ?? ""}; since ${a.releaseDate?.slice(0, 4) ?? "?"}\n   ${a.trackViewUrl ?? ""}`).join("\n")
    + "\nMany ratings on several apps means proven demand and a crowded shelf; few ratings everywhere means unproven or under-served.";
}

/** Write plan fields and the description. Shared with the hang-up pass. */
export function applyIdea(venture: VentureRow, args: Record<string, unknown>, update: IdeaUpdate): string {
  const values: Partial<Record<IdeaField, string>> = {};
  for (const key of IDEA_FIELDS) { const text = words(args[key], 4000); if (text) values[key] = text; }
  const description = words(args.description, 4000);
  const wrote: string[] = [];
  if (Object.keys(values).length) {
    const problem = writeJourneyCommand(venture, { kind: "profile", values });
    if (problem) return `Not saved: ${problem}`;
    for (const key of Object.keys(values) as IdeaField[]) wrote.push(PROFILE_FIELDS[key]);
  }
  if (description && description !== venture.description) {
    db.prepare("UPDATE ventures SET description = ?, updated_at = ? WHERE id = ?").run(description, new Date().toISOString(), venture.id);
    wrote.push("Description");
  }
  for (const label of wrote) if (!update.fields.includes(label)) update.fields.push(label);
  return wrote.length ? `Saved to the idea page: ${wrote.join(", ")}.` : "Nothing to save — send at least one field with text in it.";
}

/** File alternatives through the same merge a competitor sweep uses, so a
 *  rival met on a call and met again by a sweep is one row. */
export function applyCompetitors(venture: VentureRow, args: Record<string, unknown>, update: IdeaUpdate): string {
  const raw = Array.isArray(args.competitors) ? args.competitors : [];
  const found: Found[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    const name = words(c.name, 120);
    let url = words(c.url, 500);
    /* No website, no row: the page shows where each one lives, and a rival
       the model could not point at is one it may have made up. */
    if (!name || !url) continue;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    const domain = hostOf(url);
    /* Its own site is not the rival. */
    if (domain && venture.host && domain === venture.host.replace(/^www\./, "")) continue;
    found.push({ name, domain, url, positioning: known(c.positioning, 2000) || null, pricing: known(c.pricing, 2000) || null,
      strengths: list(c.strengths, 4, 400), weaknesses: list(c.weaknesses, 4, 400), sources: [url] });
  }
  if (!found.length) return "Nothing saved — each competitor needs a name and its website.";
  const at = new Date().toISOString();
  const merged = mergeRegistry(knownRivals(venture.id), found, at);
  writeRegistry(venture.id, `idea-call:${at}`, merged.touched);
  for (const c of found) if (!update.competitors.includes(c.name)) update.competitors.push(c.name);
  /* The plan's own "understand the alternatives" step, with its evidence —
     only when the owner has not already answered it himself. */
  const doc = readJourney(venture);
  if ((doc.state.tasks["idea:common:alternatives"]?.status ?? "todo") === "todo") {
    const names = knownRivals(venture.id).map(k => k.name).slice(0, 12).join(", ");
    writeJourneyCommand(venture, { kind: "task", key: "idea:common:alternatives", status: "done", evidence: `Found on the refine call: ${names}.` });
  }
  return `Saved ${found.length} to the idea page's alternatives: ${found.map(c => c.name).join(", ")}.`;
}

function saveName(venture: VentureRow, args: Record<string, unknown>, update: IdeaUpdate): string {
  const name = words(args.name, 100), domain = words(args.domain, 253).toLowerCase();
  const status = args.status === "ruled-out" ? "ruled-out" : "shortlisted";
  const existing = readJourney(venture).state.names.find(n => n.name.toLowerCase() === name.toLowerCase() || n.domain === domain);
  const command: JourneyCommand = { kind: "name", ...(existing ? { id: existing.id } : {}), name, domain, status, evidence: words(args.evidence, 4000) };
  const problem = writeJourneyCommand(venture, command);
  if (problem) return `Not saved: ${problem}`;
  if (!update.names.includes(name)) update.names.push(name);
  return `${name} (${domain}) is on the idea page as ${status}.`;
}

/** Run one tool. Never throws: a failure is something the model should hear
 *  about and say out loud, not something that ends the call. */
export async function runIdeaTool(name: string, args: Record<string, unknown>, venture: VentureRow, update: IdeaUpdate, signal: AbortSignal): Promise<string> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(TOOL_MS)]);
  try {
    switch (name) {
      case "web_search": return cap(await webSearch(args));
      case "read_page": return await readOnePage(args);
      case "check_domains": return await checkDomains(args, bounded);
      case "seo_check": return cap(await seoCheck(args));
      case "app_store_check": return cap(await appStoreCheck(args, bounded));
      case "update_idea": return applyIdea(venture, args, update);
      case "save_competitors": return applyCompetitors(venture, args, update);
      case "save_name": return saveName(venture, args, update);
      default: return `There is no tool called ${name}.`;
    }
  } catch (err) {
    signal.throwIfAborted();
    return `That did not work: ${err instanceof Error ? err.message : String(err)}`;
  }
}
