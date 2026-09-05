/**
 * THE LIBRARY SCOUT — go and find out what has actually been published, before
 * anything is written.
 *
 * A MODEL ASKED FOR REFERENCES INVENTS THEM. Not sometimes: that is what the
 * mechanism does when it is asked for a well-formed citation it does not have.
 * No instruction fixes it, because the instruction and the fabrication come
 * out of the same process. What fixes it is removing the choice — the model is
 * handed a numbered list of papers that exist, told to cite `[n]` from that
 * list and nothing else, and every `[n]` in the output can then be checked
 * against a row in `paper_library`. That is the entire reason this file
 * exists, and it runs BEFORE the model is asked anything.
 *
 * TWO SOURCES, BOTH KEYLESS, BOTH POLITE. OpenAlex indexes the published
 * literature and answers an unauthenticated search; arXiv carries the
 * preprints, which for anything computational is where the last twelve months
 * actually are, and answers Atom over a URL. Neither needs a credential, which
 * is why these two and not Scopus.
 *
 * THE ATOM IS PARSED WITH REGULAR EXPRESSIONS and that is a deliberate,
 * bounded choice rather than laziness. This server has one dependency and it
 * is Hono; adding an XML parser to read five fields out of a feed with a fixed
 * shape would be a dependency, a supply chain and a lockfile entry for
 * something forty lines does. The cost is real and is stated: a feed that
 * changes its shape produces fewer results rather than an error, so the run
 * says how many each source returned and a zero from a source that has always
 * returned twenty is visible as a zero.
 *
 * DE-DUPLICATION IS THREE-WAY because the same paper legitimately appears in
 * both: same DOI, same arXiv id, or the same title once case, punctuation and
 * whitespace are taken out. A preprint and its published version are the same
 * work and citing both as two is a bibliography that pads itself.
 */
import { db, now } from "../../db.ts";

const UA = "OnePersonCompany/0.1 (+papers)";
/** Each source gets ten seconds. A scout that hung would hold the single run
 *  slot the whole queue is waiting on. */
const REQUEST_MS = 10_000;
const PER_SOURCE = 25;
/** How far back OpenAlex is asked to look. A year, because the point of the
 *  library is what is CURRENT — the older canonical work is what the model
 *  already has, and what it does not have is the last twelve months. */
const WINDOW_DAYS = 365;

export type Paper = {
  source: "openalex" | "arxiv";
  extId: string;
  doi: string | null;
  title: string;
  authors: string[];
  year: number | null;
  url: string | null;
  abstract: string | null;
};

export type ScoutResult = {
  papers: Paper[];
  /** Per source: how many came back, or why none did, and — where a source
   *  had to widen its query — which query answered. Reported rather than
   *  swallowed: a paper written off one source instead of two is a different
   *  document, and a library built from loosened terms is a looser library.
   *  The owner is entitled to both facts. */
  notes: { source: string; found: number; error: string | null; note: string | null }[];
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function getText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json, application/atom+xml;q=0.9, */*;q=0.5" },
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  return res.text();
}

/**
 * OpenAlex.
 *
 * NO `mailto`, and that is a decision rather than an omission. OpenAlex asks
 * for one to put callers in its faster pool; this box has no address it is
 * entitled to publish to a third party on the owner's behalf, and inventing
 * one would be sending a stranger a fake contact. The unauthenticated pool
 * answers this volume — twenty-five works, once per run — perfectly well.
 *
 * THE ABSTRACT ARRIVES INVERTED. OpenAlex publishes `abstract_inverted_index`,
 * a map of word to the positions it appears at, for licensing reasons. It is
 * reassembled here because a library entry with no abstract is a title the
 * model cannot tell apart from a hundred other titles.
 */
async function openalex(topic: string): Promise<{ papers: Paper[]; error: string | null }> {
  const from = new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const url =
    `https://api.openalex.org/works?search=${encodeURIComponent(topic)}` +
    `&filter=from_publication_date:${from}&per-page=${PER_SOURCE}`;
  try {
    const doc = JSON.parse(await getText(url)) as {
      results?: {
        id?: string;
        doi?: string | null;
        title?: string | null;
        display_name?: string | null;
        publication_year?: number | null;
        authorships?: { author?: { display_name?: string } }[];
        primary_location?: { landing_page_url?: string | null } | null;
        abstract_inverted_index?: Record<string, number[]> | null;
      }[];
    };
    const papers: Paper[] = [];
    for (const w of doc.results ?? []) {
      const title = (w.title ?? w.display_name ?? "").trim();
      const id = (w.id ?? "").split("/").pop() ?? "";
      if (!title || !id) continue;
      papers.push({
        source: "openalex",
        extId: id,
        doi: w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//, "") : null,
        title,
        authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? "").filter(Boolean).slice(0, 12),
        year: w.publication_year ?? null,
        url: w.primary_location?.landing_page_url ?? (w.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/doi\.org\//, "")}` : w.id ?? null),
        abstract: uninvert(w.abstract_inverted_index ?? null),
      });
    }
    return { papers, error: null };
  } catch (err) {
    return { papers: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function uninvert(index: Record<string, number[]> | null): string | null {
  if (!index) return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word;
  const text = words.filter(Boolean).join(" ").trim();
  return text ? text.slice(0, 1_200) : null;
}

/**
 * arXiv's Atom feed. See the header for why this is regular expressions.
 *
 * SORTED BY RELEVANCE AND NOT BY DATE, which is a correction rather than a
 * preference. Sorted by `submittedDate` descending — the obvious choice, and
 * the one this was first written with — a multi-word `all:` query matches
 * loosely enough that what comes back is simply the newest twenty-five things
 * arXiv has. Measured on 2026-09-05 for "planning permission search systems":
 * the library came back holding a paper on seasonal dark matter, one on
 * hydrogel drug delivery and one on quantum nonlocality. That is not a thin
 * library, it is a library about nothing, and a paper told to cite only from it
 * would be citing at random.
 *
 * The phrase is quoted first, which is what a search for a SUBJECT means. A
 * quoted phrase can legitimately match nothing at all, so a zero falls back to
 * the unquoted terms — still by relevance — and the caller is told which query
 * answered, because "twenty-five loosely related papers" and "four papers
 * actually about this" are different libraries and the difference belongs in
 * the report.
 */
async function arxiv(topic: string): Promise<{ papers: Paper[]; error: string | null; note: string | null }> {
  const phrase = `all:"${topic}"`;
  const loose = topic
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .map((w) => `all:${w}`)
    .join("+AND+");

  const first = await arxivQuery(phrase);
  if (first.error || first.papers.length) return { ...first, note: first.papers.length ? "phrase" : null };
  if (!loose) return { ...first, note: null };
  const second = await arxivQuery(loose);
  return { ...second, note: second.papers.length ? "terms, all required — the exact phrase returned nothing" : null };
}

async function arxivQuery(query: string): Promise<{ papers: Paper[]; error: string | null }> {
  const url =
    `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query).replace(/%2B/g, "+")}` +
    `&max_results=${PER_SOURCE}&sortBy=relevance&sortOrder=descending`;
  try {
    const xml = await getText(url);
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1] ?? "");
    const papers: Paper[] = [];
    for (const e of entries) {
      const id = (one(e, "id") ?? "").replace(/^https?:\/\/arxiv\.org\/abs\//, "").trim();
      const title = clean(one(e, "title") ?? "");
      if (!id || !title) continue;
      const published = one(e, "published") ?? "";
      papers.push({
        source: "arxiv",
        extId: id,
        doi: one(e, "arxiv:doi"),
        title,
        authors: [...e.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)]
          .map((m) => clean(m[1] ?? ""))
          .filter(Boolean)
          .slice(0, 12),
        year: published ? Number(published.slice(0, 4)) || null : null,
        url: `https://arxiv.org/abs/${id}`,
        abstract: (clean(one(e, "summary") ?? "") || null)?.slice(0, 1_200) ?? null,
      });
    }
    return { papers, error: null };
  } catch (err) {
    return { papers: [], error: err instanceof Error ? err.message : String(err) };
  }
}

function one(xml: string, tag: string): string | null {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? (m[1] ?? "").trim() : null;
}

function clean(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** Both sources, de-duplicated, newest-looking first. arXiv is put in front of
 *  OpenAlex on a tie because it is the preprint and therefore the earlier
 *  record of the same work. */
export async function scout(topic: string): Promise<ScoutResult> {
  const [a, b] = await Promise.all([openalex(topic), arxiv(topic)]);
  const notes = [
    { source: "openalex", found: a.papers.length, error: a.error, note: null as string | null },
    { source: "arxiv", found: b.papers.length, error: b.error, note: b.note },
  ];

  const seenDoi = new Set<string>();
  const seenTitle = new Set<string>();
  const seenId = new Set<string>();
  const papers: Paper[] = [];
  for (const p of [...b.papers, ...a.papers]) {
    const doi = p.doi?.toLowerCase() ?? null;
    const title = norm(p.title);
    const key = `${p.source}:${p.extId}`;
    if (seenId.has(key)) continue;
    if (doi && seenDoi.has(doi)) continue;
    if (title && seenTitle.has(title)) continue;
    seenId.add(key);
    if (doi) seenDoi.add(doi);
    if (title) seenTitle.add(title);
    papers.push(p);
  }
  return { papers, notes };
}

/** Write what was found. `INSERT OR REPLACE` rather than IGNORE, so a second
 *  scout that got a fuller abstract or a corrected year improves the row
 *  instead of keeping the first version for ever. `seen_at` therefore means
 *  "last confirmed to exist", which is what a reader wants of it. */
export function saveLibrary(papers: Paper[], topic: string, ventureId: string | null) {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO paper_library
       (source, ext_id, venture_id, topic, doi, title, authors, year, url, abstract, seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ts = now();
  for (const p of papers)
    stmt.run(p.source, p.extId, ventureId, topic, p.doi, p.title, JSON.stringify(p.authors), p.year, p.url, p.abstract, ts);
}

export type LibraryRow = {
  source: string;
  ext_id: string;
  venture_id: string | null;
  topic: string;
  doi: string | null;
  title: string;
  authors: string;
  year: number | null;
  url: string | null;
  abstract: string | null;
  seen_at: string;
};

export function libraryRows(opts: { ventureId?: string | null; topic?: string | null; limit?: number }): LibraryRow[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (opts.ventureId) {
    where.push("venture_id = ?");
    args.push(opts.ventureId);
  }
  if (opts.topic) {
    where.push("topic = ?");
    args.push(opts.topic);
  }
  args.push(Math.max(1, Math.min(500, Math.floor(opts.limit ?? 200))));
  return db
    .prepare(
      `SELECT * FROM paper_library ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seen_at DESC, year DESC LIMIT ?`,
    )
    .all(...args) as unknown as LibraryRow[];
}
