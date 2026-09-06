/**
 * THE SERP TEARDOWN — what the pages that beat us actually have on them.
 *
 * THE GAP THIS FILLS. `ventures/audit.ts` is very good at saying what is wrong
 * with the owner's own page and has never once been able to say what a page
 * that outranks it looks like, because the audit is a crawl of his own sites.
 * So every SEO recommendation this box could make was measured against a
 * checklist rather than against the competition, and the most common
 * instruction it can produce is a version of "add an H1". `competitors` runs
 * profile a RIVAL — company-level, one profile per business. This is per
 * QUERY, because ranking is per query: the pages above us for "planning
 * permission search" are a different set from the pages above us for "planning
 * appeal ireland", and the reason we sit behind each set is different.
 *
 * WHERE THE QUERIES COME FROM, in the order they are tried, and the ORIGIN IS
 * RECORDED because the three are not equally good evidence:
 *
 *   owner        typed into the form. The best kind: somebody decided.
 *   gsc          striking-distance queries out of Search Console — position 5
 *                to 20, most impressions first. A page already exists, Google
 *                already shows it, and the only thing between it and clicks is
 *                what is on the pages above.
 *   description  derived mechanically from the venture record when there is no
 *                Search Console property. This is a GUESS AT A QUERY and the
 *                report says so: it is not evidence that anybody searches for
 *                it, and a teardown of a query nobody types explains nothing.
 *
 * TWO POSITIONS, NEVER ONE. `our_rank` is where our host came in the SearXNG
 * result list — a metasearch node's own merged order, on this one request, from
 * whichever engines answered. `gsc_position` is Google's own average position
 * over Search Console's window. They measure different things on different days
 * and the row keeps both apart; a report that folded them into "our position"
 * would be inventing a figure out of two real ones.
 *
 * THE SELF-CHECK GATES THE CONCLUSIONS. See pages.ts: below thirty percent
 * overlap between the query's words and the results' titles the query is marked
 * degraded and NO gap list is drawn from it. A gap list computed from ten pages
 * about something else is worse than no gap list.
 *
 * WHAT THE MODEL IS FOR. Nothing numeric. The structures are read in code, the
 * medians are arithmetic and the gap list is a comparison — all of it is done
 * before any model is asked anything. The model is handed the finished table
 * and asked for the prose: what those pages are doing that ours is not, and
 * what to do about it. Figures first, prose second, and the figures are never
 * the model's.
 */
import { db, now, type VentureRow } from "../../db.ts";
import * as searxng from "../../providers/searxng.ts";
import { hostMatch, hostOf, registrable } from "../../shared/host.ts";
import {
  gapsAgainst,
  readPage,
  relevance,
  tokens,
  unmeasurable,
  type Gap,
  type PageStructure,
} from "./pages.ts";
import type { RunTools } from "./runs.ts";

/** Queries per run. Each one is a search, up to five page fetches and a share
 *  of one model turn; five is a run of a few minutes and twenty is a run
 *  nobody waits for. */
const MAX_QUERIES = 5;
/** Competitor pages kept per query, after ours and the duplicates are out. */
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 8;
/** A Search Console query below this many impressions is not worth the fetches:
 *  the sample is too small for the position to be real. */
const MIN_IMPRESSIONS = 3;

/* ----------------------------------------------------------- the queries */

export type PickedQuery = {
  query: string;
  source: "owner" | "gsc" | "description";
  gscPosition: number | null;
  gscImpressions: number | null;
};

/** The Search Console property that COVERS this venture's host. The property
 *  string is `sc-domain:example.com` or a URL prefix; `hostOf` reduces both,
 *  and a venture with no matching property gets none rather than the first one
 *  in the table.
 *
 *  ONE-DIRECTIONAL, through `shared/host.ts`. A property covers a host when it
 *  IS that host or the host sits under it. Folding both sides to the
 *  registrable domain — which is what this did — also matched a property for
 *  `blog.example.com` against a venture at `example.com`, which is a property
 *  that measures a different site. */
export function propertyFor(host: string | null): string | null {
  if (!host) return null;
  const rows = db.prepare("SELECT property FROM gsc_sites").all() as unknown as { property: string }[];
  for (const r of rows) if (hostMatch(r.property, host)) return r.property;
  return null;
}

/**
 * STRIKING DISTANCE, DEFINED ONCE.
 *
 * Position 5 to 20, at least `MIN_IMPRESSIONS` of them, most impressions
 * first.
 *
 * Above position 5 there is little between us and the click that a
 * competitor's page explains; past 20 the pages above are not competing for
 * the same intent. The floor on impressions is there because sorting by
 * impressions with no floor means the best candidate on a quiet site wins by
 * default rather than on merit.
 *
 * THERE USED TO BE TWO DEFINITIONS OF THIS ONE RECOMMENDATION and they
 * published different lists over the same rows: the dashboard took 11–20 with
 * no impressions floor, this took 5–20 with one. A query at position 7 was a
 * target for the teardown and invisible on the dashboard; a query at 15 with a
 * single impression was on the dashboard and excluded from the teardown. The
 * band below is the one with the reasons written down, and both surfaces read
 * it.
 *
 * `property` narrows it to one Search Console property; `null` means every
 * property this box holds, which is what a portfolio-wide board wants.
 */
export const STRIKING_MIN_POSITION = 5;
export const STRIKING_MAX_POSITION = 20;

export type StrikingRow = {
  property: string;
  query: string;
  clicks: number;
  impressions: number;
  position: number | null;
};

export function strikingRows(property: string | null, limit: number): StrikingRow[] {
  const scoped = property ? "AND property = ?" : "";
  const args: (string | number)[] = property ? [property] : [];
  return db
    .prepare(
      `SELECT property, query, clicks, impressions, position FROM gsc_queries
        WHERE position >= ? AND position <= ? AND impressions >= ? ${scoped}
        ORDER BY impressions DESC, query LIMIT ?`,
    )
    .all(STRIKING_MIN_POSITION, STRIKING_MAX_POSITION, MIN_IMPRESSIONS, ...args, limit) as unknown as StrikingRow[];
}

export function strikingQueries(property: string, limit: number): PickedQuery[] {
  return strikingRows(property, limit).map((r) => ({
    query: r.query,
    source: "gsc" as const,
    gscPosition: r.position ?? null,
    gscImpressions: r.impressions,
  }));
}

/**
 * A query derived from the venture record, when there is nothing better.
 *
 * MECHANICAL ON PURPOSE. A model asked to invent search queries invents
 * plausible ones, and a teardown of a plausible query that nobody types looks
 * exactly like a teardown of a real one. So this takes the description's own
 * words: the first clause, reduced to its content words and capped at six,
 * which is a phrase somebody might actually type if the description says what
 * the thing is. Where the description is too short to reduce, the venture's
 * name is the query — which is a brand query, is nearly useless as a teardown,
 * and is at least honestly labelled as derived.
 */
export function describedQueries(v: VentureRow, limit: number): PickedQuery[] {
  const out: PickedQuery[] = [];
  const clause = (v.description || "").split(/[.!?\n]/).map((s) => s.trim()).filter(Boolean)[0] ?? "";
  const words = tokens(clause).filter((w) => w !== v.name.toLowerCase());
  if (words.length >= 2) out.push({ query: words.slice(0, 6).join(" "), source: "description", gscPosition: null, gscImpressions: null });
  if (out.length < limit && v.name) out.push({ query: v.name, source: "description", gscPosition: null, gscImpressions: null });
  return out.slice(0, limit);
}

/** The queries this run will tear down, and where each came from. */
export function pickQueries(v: VentureRow, typed: string): PickedQuery[] {
  const owner = typed
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_QUERIES)
    .map((query) => ({ query, source: "owner" as const, gscPosition: null, gscImpressions: null }));
  if (owner.length) return owner;

  const property = propertyFor(v.host);
  if (property) {
    const striking = strikingQueries(property, 3);
    if (striking.length) return striking;
  }
  return describedQueries(v, 2);
}

/* ------------------------------------------------------------- the search */

type Result = { title: string; url: string; content: string | null };

async function search(query: string): Promise<{ results: Result[]; refused: { engine: string; reason: string }[] } | { error: string }> {
  const url = searxng.endpoint();
  const borrowed = searxng.borrowKey("serp_teardown");
  if (!borrowed)
    return {
      error:
        "SearXNG is not connected, and a teardown is a search. Install the local instance from the SearXNG page, or paste the URL and key of a node you already run.",
    };
  try {
    const answer = await searxng.ask(borrowed.url || url, borrowed.key, { query });
    return {
      results: answer.results.map((r) => ({ title: r.title, url: r.url, content: r.content })),
      refused: answer.engines.refused,
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/* ------------------------------------------------------------- the row */

export type SerpRow = {
  query: string;
  source: string;
  gscPosition: number | null;
  gscImpressions: number | null;
  ourRank: number | null;
  ourUrl: string | null;
  ours: PageStructure | null;
  competitors: PageStructure[];
  relevance: number | null;
  degraded: boolean;
  unmeasurable: string | null;
  gaps: Gap[];
  /** Engines that refused THIS search. A node down to one engine still returns
   *  ten links and still looks healthy, so this is carried onto the report. */
  refused: { engine: string; reason: string }[];
  error: string | null;
};

/* --------------------------------------------------------------- the run */

/**
 * One teardown.
 *
 * The shape is: pick the queries, search, read the pages, compute the gaps,
 * write the rows, print the figures, and only then ask a model for the prose.
 * Every step is bounded and every failure is a sentence on a row rather than a
 * thrown run: a query whose search failed still appears in the report, saying
 * that it failed, because a query silently missing from a teardown reads as a
 * query with nothing to say about it.
 */
export async function serpRun(runId: string, v: VentureRow, input: Record<string, string>, tools: RunTools): Promise<void> {
  const perQuery = Math.max(3, Math.min(MAX_RESULTS, Number(input.results ?? DEFAULT_RESULTS) || DEFAULT_RESULTS));
  const picked = pickQueries(v, input.queries ?? "");
  if (!picked.length)
    throw new Error(
      "There is nothing to tear down: no queries were typed, no Search Console property matches this venture's host, and the venture record has no description to derive one from.",
    );

  const ourHost = v.host ? registrable(v.host) : null;
  const rows: SerpRow[] = [];

  for (const q of picked) {
    const step = tools.startStep("serp", `${q.query} (${q.source})`);
    const row: SerpRow = {
      query: q.query,
      source: q.source,
      gscPosition: q.gscPosition,
      gscImpressions: q.gscImpressions,
      ourRank: null,
      ourUrl: null,
      ours: null,
      competitors: [],
      relevance: null,
      degraded: false,
      unmeasurable: unmeasurable(q.query),
      gaps: [],
      refused: [],
      error: null,
    };

    const got = await search(q.query);
    if ("error" in got) {
      row.error = got.error;
      rows.push(row);
      tools.endStep(step, `search failed — ${got.error}`);
      continue;
    }
    row.refused = got.refused;

    /* THE CHECK BEFORE THE CONCLUSIONS. An unmeasurable query is searched and
       reported and never judged; a degraded one is searched, reported, and the
       gap list is withheld with the ratio printed beside it. */
    if (!row.unmeasurable) {
      const rel = relevance(q.query, got.results);
      row.relevance = rel.ratio;
      row.degraded = rel.degraded;
    }

    /* Where we came, and one page per registrable domain so a competitor's
       three subdomains do not eat the sample. */
    const seen = new Set<string>();
    const competitors: Result[] = [];
    got.results.forEach((r, i) => {
      const h = hostOf(r.url);
      if (!h) return;
      const dom = registrable(h);
      if (ourHost && dom === ourHost) {
        if (row.ourRank === null) {
          row.ourRank = i + 1;
          row.ourUrl = r.url;
        }
        return;
      }
      if (seen.has(dom)) return;
      seen.add(dom);
      if (competitors.length < perQuery) competitors.push(r);
    });

    for (const c of competitors) row.competitors.push(await readPage(c.url));

    /* OUR PAGE. The one that actually ranked when we ranked; the site's front
       page when we did not — which is a fair comparison for a query we are not
       in the results for at all, and is labelled as such on the report. */
    const ourTarget = row.ourUrl ?? v.website ?? null;
    if (ourTarget) {
      row.ours = await readPage(ourTarget);
      row.ourUrl ??= ourTarget;
    }

    if (!row.degraded && !row.unmeasurable) row.gaps = gapsAgainst(row.ours, row.competitors);

    rows.push(row);
    tools.endStep(
      step,
      row.degraded
        ? `degraded (${row.relevance} of the query's words came back) — no gaps drawn`
        : `${row.competitors.filter((c) => !c.error).length} pages read, we are ${row.ourRank ? `#${row.ourRank}` : "not in the results"}`,
    );
  }

  saveRows(runId, v.id, rows);
  tools.say(renderFindings(v, rows));

  /* THE PROSE, AND ONLY THE PROSE. The model is handed the table it must not
     recompute and told, in terms, that every figure it may use is already
     written above it. */
  const write = tools.startStep("write", "what they have that we do not");
  const usable = rows.filter((r) => !r.error && !r.degraded && !r.unmeasurable && r.competitors.some((c) => !c.error));
  const res = await tools.turn(
    [
      {
        role: "system",
        content: [
          `You are writing the second half of a SERP teardown for ${v.name}${v.host ? ` (${v.host})` : ""}.`,
          ``,
          `WHAT THE OWNER SAYS THIS BUSINESS IS: ${v.description || "nothing written down"}`,
          ``,
          `THE FIRST HALF IS ALREADY WRITTEN AND IS ABOVE YOUR ANSWER. It is a table of page structures this server read out of the HTML itself: word counts, heading counts, link counts, schema types, and the three markers. You did not compute it and you must not recompute it.`,
          ``,
          `RULES, all binding:`,
          `- NEVER INVENT A FIGURE. Every number you write must appear in the data below. If you want one that is not there, say it is not measured.`,
          `- A DEGRADED QUERY PROVES NOTHING. Where a query is marked degraded the search engine answered a different question; do not draw any conclusion about those pages.`,
          `- A PAGE MARKED thin OR error WAS NOT READ. A 403 from a firewall is not a short page.`,
          `- "OUR RANK" IS THE METASEARCH NODE'S ORDER ON ONE REQUEST, not Google's position. Where a Google position is given it is Search Console's average over its own window. Never merge the two and never call either "our ranking" without saying which.`,
          `- A QUERY MARKED source=description WAS DERIVED FROM THE VENTURE RECORD by this server. Nothing says anybody searches for it. Say so if you use it.`,
          ``,
          `THE DATA:`,
          ``,
          renderData(v, rows),
          ``,
          `WRITE EXACTLY THIS, starting at the heading, and nothing before it:`,
          ``,
          `## What they have that we do not`,
          `Per query that produced a usable comparison, the specific things the pages above us carry that ours does not — quoting the figures from the table. Where we are ahead on a field and still behind on the SERP, say that: it is the finding that stops a "make it longer" recommendation being made by reflex.`,
          ``,
          `## Recommendations`,
          `Ranked, each one a change somebody could start this week on a named page of ours. Say what it costs and what it would change.`,
          ``,
          `Then a final fenced block, info string exactly \`json cards\`, holding 3 to 8 board-card suggestions as [{"title": "…", "body": "…", "urgency": 0-3}].`,
        ].join("\n"),
      },
      {
        role: "user",
        content: usable.length
          ? `Read the teardown of ${usable.length} quer${usable.length === 1 ? "y" : "ies"} for ${v.name} and write the two sections.`
          : `No query in this teardown produced a usable comparison. Write the two sections saying exactly that and what would have to change for the next run to produce one.`,
      },
    ],
    { toOutput: true },
  );
  tools.endStep(write, `${res.text.length} characters`);
}

/* ------------------------------------------------------------- persistence */

function saveRows(runId: string, ventureId: string, rows: SerpRow[]) {
  const ts = now();
  const stmt = db.prepare(
    `INSERT INTO growth_serp
       (run_id, venture_id, query, source, gsc_position, gsc_impressions, our_rank, our_url, ours,
        competitors, relevance, degraded, unmeasurable, gaps, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, query) DO UPDATE SET
       our_rank = excluded.our_rank, ours = excluded.ours, competitors = excluded.competitors,
       relevance = excluded.relevance, degraded = excluded.degraded, gaps = excluded.gaps, ts = excluded.ts`,
  );
  for (const r of rows)
    stmt.run(
      runId,
      ventureId,
      r.query,
      r.source,
      r.gscPosition,
      r.gscImpressions,
      r.ourRank,
      r.ourUrl,
      r.ours ? JSON.stringify(r.ours) : null,
      JSON.stringify(r.competitors),
      r.relevance,
      r.degraded ? 1 : 0,
      r.unmeasurable,
      JSON.stringify(r.gaps),
      ts,
    );
}

/* ---------------------------------------------------------------- rendering */

const esc = (s: string) => s.replace(/\|/g, "\\|");
const n = (v: number | null) => (v === null ? "—" : String(v));

/** The data block the model is handed: the same figures as the report, in the
 *  shape a model reads best. */
function renderData(v: VentureRow, rows: SerpRow[]): string {
  const out: string[] = [];
  for (const r of rows) {
    out.push(`QUERY: ${r.query} (source: ${r.source})`);
    if (r.error) {
      out.push(`  the search failed: ${r.error}`);
      out.push("");
      continue;
    }
    if (r.unmeasurable) out.push(`  unmeasurable: ${r.unmeasurable}`);
    if (r.degraded) out.push(`  DEGRADED: only ${r.relevance} of the query's countable words came back in the titles and snippets. Draw no conclusion from this query.`);
    out.push(
      `  our place in the SearXNG results: ${r.ourRank ? `#${r.ourRank}` : "not in them"}` +
        (r.gscPosition !== null ? `; Google's average position over Search Console's window: ${r.gscPosition}${r.gscImpressions !== null ? ` over ${r.gscImpressions} impressions` : ""}` : ""),
    );
    if (r.ours)
      out.push(
        `  OUR PAGE ${r.ours.url}: ${r.ours.error ? `could not be read — ${r.ours.error}` : `${r.ours.words} words, ${r.ours.h2.length} h2, ${r.ours.h3Count} h3, ${r.ours.internalLinks} internal links, ${r.ours.externalLinks} external, ${r.ours.images} images, schema [${r.ours.schema.join(", ") || "none"}], faq ${r.ours.faq}, table ${r.ours.table}, comparison framing ${r.ours.comparison}. Title: ${r.ours.title ?? "none"}`}`,
      );
    for (const c of r.competitors)
      out.push(
        `  THEIRS ${c.url}: ${c.error ? `not read — ${c.error}` : c.thin ? `only ${c.chars} characters of readable text came back, so this page was not read` : `${c.words} words, ${c.h2.length} h2, ${c.h3Count} h3, ${c.internalLinks} internal links, ${c.externalLinks} external, ${c.images} images, schema [${c.schema.join(", ") || "none"}], faq ${c.faq}, table ${c.table}, comparison framing ${c.comparison}. Title: ${c.title ?? "none"}. Headings: ${c.h2.slice(0, 8).join(" | ") || "none"}`}`,
      );
    if (r.gaps.length)
      out.push(`  MEDIAN OF THE PAGES READ vs OURS: ${r.gaps.map((g) => `${g.field} ${n(g.ours)} vs ${n(g.theirs)} (over ${g.of})`).join("; ")}`);
    out.push("");
  }
  out.push(`The venture record: ${v.name}, ${v.website ?? "no site"}, stage ${v.stage}.`);
  return out.join("\n");
}

/** `## Findings` and `## Evidence`, composed HERE rather than by a model,
 *  because they are the measurement. A table a model wrote from its own reading
 *  of a table would be the instrument marking its own paper. */
function renderFindings(v: VentureRow, rows: SerpRow[]): string {
  const out: string[] = [
    `## Findings`,
    ``,
    `${rows.length} quer${rows.length === 1 ? "y" : "ies"} torn down for ${v.name}. Every figure below was read out of the pages' own HTML by this server; no model computed any of it.`,
    ``,
    `TWO POSITIONS AND THEY ARE NOT THE SAME NUMBER. "Ours" is where ${v.host ?? "this site"} came in the SearXNG result list on this one request, from whichever engines answered it. "Google" is Search Console's average position for the query over its own window, and it is only present for queries that came from Search Console.`,
    ``,
    `| Query | Source | Ours | Google | Pages read | Check |`,
    `| --- | --- | --- | --- | --- | --- |`,
  ];
  for (const r of rows)
    out.push(
      `| ${esc(r.query)} | ${r.source} | ${r.ourRank ? `#${r.ourRank}` : "not in results"} | ${r.gscPosition === null ? "—" : r.gscPosition.toFixed(1)} | ${r.competitors.filter((c) => !c.error && !c.thin).length} | ${
        r.error ? `search failed` : r.unmeasurable ? "unmeasurable" : r.degraded ? `degraded (${r.relevance})` : `ok (${r.relevance})`
      } |`,
    );

  for (const r of rows) {
    out.push(``, `### ${r.query}`, ``);
    if (r.error) {
      out.push(`The search failed: ${r.error}`);
      continue;
    }
    if (r.unmeasurable) out.push(`This query cannot be checked for relevance: ${r.unmeasurable}. The pages below were read; no gap list is drawn.`, ``);
    if (r.degraded)
      out.push(
        `DEGRADED. Only ${r.relevance} of this query's countable words appear in the titles and snippets that came back, which is under the ${0.3} floor — the engine answered a different question. The pages are listed for the record and NO gap list is drawn from them.`,
        ``,
      );
    if (r.refused.length)
      out.push(`Engines that refused this search: ${r.refused.map((e) => `${e.engine} (${e.reason})`).join(", ")}. What came back is what the rest of them had.`, ``);

    out.push(`| Page | Words | h2 | h3 | Internal | External | Images | Schema | FAQ | Table | Comparison |`, `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    const line = (p: PageStructure, label: string) =>
      p.error
        ? `| ${label} ${esc(p.url)} | not read — ${esc(p.error)} | | | | | | | | | |`
        : p.thin
          ? `| ${label} ${esc(p.url)} | only ${p.chars} chars of text came back | | | | | | | | | |`
          : `| ${label} ${esc(p.url)} | ${p.words} | ${p.h2.length} | ${p.h3Count} | ${p.internalLinks} | ${p.externalLinks} | ${p.images} | ${esc(p.schema.join(", ") || "none")} | ${p.faq ? "yes" : "no"} | ${p.table ? "yes" : "no"} | ${p.comparison ? "yes" : "no"} |`;
    if (r.ours) out.push(line(r.ours, r.ourRank ? "**ours**" : "**ours (front page — we are not in these results)**"));
    for (const c of r.competitors) out.push(line(c, ""));

    if (r.gaps.length) {
      out.push(``, `Median of the pages read, against ours. A median rather than a mean: one long glossary in a set of five would move a mean past every real page. Pages that could not be read are out of the denominator.`, ``);
      out.push(`| Field | Ours | Median of ${r.gaps[0]!.of} | What it is |`, `| --- | --- | --- | --- |`);
      for (const g of r.gaps) out.push(`| ${g.field} | ${n(g.ours)} | ${n(g.theirs)} | ${esc(g.what)} |`);
    }
  }

  out.push(
    ``,
    `## Evidence`,
    ``,
    `Every page above is linked by its own URL and was fetched by this server; the figures are counts over that HTML. What is NOT here: how Google actually ranks these pages, anybody's backlinks, and any figure about search volume — none of the three is measured by a teardown.`,
    ``,
  );
  return out.join("\n");
}

/* ------------------------------------------------------------- the reads */

export type StoredSerpRow = {
  run_id: string;
  venture_id: string;
  query: string;
  source: string;
  gsc_position: number | null;
  gsc_impressions: number | null;
  our_rank: number | null;
  our_url: string | null;
  ours: string | null;
  competitors: string;
  relevance: number | null;
  degraded: number;
  unmeasurable: string | null;
  gaps: string;
  ts: string;
};

const parse = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/** One stored row, on the wire. */
export function shapeRow(r: StoredSerpRow) {
  const ours = parse<PageStructure | null>(r.ours, null);
  const competitors = parse<PageStructure[]>(r.competitors, []);
  return {
    runId: r.run_id,
    ventureId: r.venture_id,
    query: r.query,
    source: r.source,
    /** Google's average position over Search Console's own window. NEVER the
     *  same figure as `ourRank`. */
    gscPosition: r.gsc_position,
    gscImpressions: r.gsc_impressions,
    /** Where our host came in the SearXNG result list on one request. Null is
     *  "not in the results", which is a measurement. */
    ourRank: r.our_rank,
    ourUrl: r.our_url,
    ours,
    competitors,
    relevance: r.relevance,
    degraded: r.degraded === 1,
    unmeasurable: r.unmeasurable,
    gaps: parse<Gap[]>(r.gaps, []),
    ts: r.ts,
  };
}

export function rowsForRun(runId: string) {
  const rows = db.prepare("SELECT * FROM growth_serp WHERE run_id = ? ORDER BY rowid").all(runId) as unknown as StoredSerpRow[];
  return rows.map(shapeRow);
}

export function rowsForVenture(ventureId: string, limit: number) {
  const rows = db
    .prepare("SELECT * FROM growth_serp WHERE venture_id = ? ORDER BY ts DESC, rowid LIMIT ?")
    .all(ventureId, limit) as unknown as StoredSerpRow[];
  return rows.map(shapeRow);
}

/* ------------------------------------------------------ the competitor set */

export type Competitor = {
  /** The registrable domain, which is the key the two registries can be joined
   *  on. Grouping only — see `shared/host.ts` on why it may never decide
   *  ownership. */
  domain: string;
  /** The written profile, where a sweep produced one. */
  profile: {
    name: string;
    url: string | null;
    positioning: string | null;
    pricing: string | null;
    lastVerified: string;
    firstSeen: string;
  } | null;
  /** How the teardowns actually saw them: which queries, and the best rank the
   *  stored rows put them at. Empty means nobody has measured them ranking. */
  ranking: { queries: string[]; pages: number };
  /** Which registry knew about them. `both` is the interesting one. */
  evidence: "ranking" | "profile" | "both";
};

/**
 * ONE COMPETITOR SET FOR A VENTURE, OUT OF THE TWO REGISTRIES THAT HOLD ONE.
 *
 * TWO ANSWERS TO ONE QUESTION, AND THEY NEVER JOINED. A teardown discovers
 * rivals mechanically — a search engine put them above us on our own query and
 * their page was read — and files them per query inside a run's row. A
 * competitor sweep writes PROFILES: a name, a positioning, a price, verified
 * by a model and edited by the owner. So a domain outranking the venture on
 * every teardown query never appeared among the profiles, and a profiled rival
 * carried no evidence it ranks for anything.
 *
 * THE JOIN KEY IS THE REGISTRABLE DOMAIN, because it is the only thing both
 * sides have: a profile has a name and usually a URL, a teardown has a URL and
 * no name. A profile with no readable URL cannot be joined and is returned on
 * its own name rather than dropped — an unjoined profile is still the owner's
 * research.
 *
 * THIS IS THE READ HALF. The two registries are still two tables; one table
 * keyed on the registrable domain, with the teardown filing what it discovers,
 * is a migration.
 */
export function competitorSet(ventureId: string, limit = 60): Competitor[] {
  const out = new Map<string, Competitor>();

  for (const row of rowsForVenture(ventureId, limit)) {
    for (const c of row.competitors) {
      const domain = registrable(c.domain ?? hostOf(c.url));
      if (!domain) continue;
      const held = out.get(domain) ?? {
        domain,
        profile: null,
        ranking: { queries: [], pages: 0 },
        evidence: "ranking" as const,
      };
      if (!held.ranking.queries.includes(row.query)) held.ranking.queries.push(row.query);
      held.ranking.pages += 1;
      out.set(domain, held);
    }
  }

  const profiles = db
    .prepare(
      `SELECT name, url, positioning, pricing, last_verified, first_seen
         FROM competitor_profiles WHERE venture_id = ?`,
    )
    .all(ventureId) as unknown as {
    name: string;
    url: string | null;
    positioning: string | null;
    pricing: string | null;
    last_verified: string;
    first_seen: string;
  }[];

  for (const p of profiles) {
    const domain = registrable(hostOf(p.url)) || p.name.trim().toLowerCase();
    const held = out.get(domain);
    const profile = {
      name: p.name,
      url: p.url,
      positioning: p.positioning,
      pricing: p.pricing,
      lastVerified: p.last_verified,
      firstSeen: p.first_seen,
    };
    if (held) out.set(domain, { ...held, profile, evidence: "both" });
    else
      out.set(domain, {
        domain,
        profile,
        ranking: { queries: [], pages: 0 },
        evidence: "profile",
      });
  }

  return [...out.values()].sort(
    (a, b) => b.ranking.queries.length - a.ranking.queries.length || a.domain.localeCompare(b.domain),
  );
}
