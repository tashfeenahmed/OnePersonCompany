/**
 * IS THIS SEARCH QUERY SOMEBODY LOOKING FOR US BY NAME, OR SOMEBODY DESCRIBING
 * A NEED WE COULD WIN.
 *
 * Search Console returns a venture's own brand and every misspelling of it
 * alongside the queries that describe what it does, and the two want opposite
 * treatment. "improve the page targeting 'freellmapi github'" is not work: the
 * searcher already knew the name and typed it, the page they wanted is the one
 * they got, and a card proposing to rewrite a title for it is a card that
 * cannot be done. The growth source used to file those because its only filter
 * was impressions and position, which brand rows clear easily — they are the
 * rows a small site has the most of.
 *
 * WHY THIS IS A MODEL'S JUDGMENT AND NO LONGER A STRING COMPARISON
 *
 * The owner's rule, 2026-09-21: a gate that decides a matter of MEANING is an
 * LLM judgment, never word matching. This gate was the clearest case in the
 * codebase for it. Its previous version folded three spellings of the name to
 * letters and digits and asked four questions of every query word — is it equal
 * to a token, does it contain a token of five characters or more, is it within
 * one edit of a short token or two of a long one, does the whole query with its
 * spaces removed match — and each of those numbers was a guess that had already
 * been retuned once. Four characters, five characters, distance one, distance
 * two, "one or two words only": five hand-set dials standing in for one
 * question a competent reader answers instantly.
 *
 * The dials could not answer it. The old header spent forty lines arguing with
 * itself about a single pair of queries, because `free llm api` concatenates to
 * `freellmapi` EXACTLY — the venture's name is the generic phrase it serves.
 * The resolution was a rule with no meaning behind it: apply the whole-query
 * comparison only to queries of one or two words. That rule is why `free llmapi`
 * was brand and `best free llm api` was not, and nothing about the number two
 * explains the difference. A model is told what the difference IS: a name typed
 * with a stray space is a typo, a category typed in words is a person
 * describing the category.
 *
 * ONE CALL FOR THE WHOLE SWEEP. `sources.ts` collects every candidate query it
 * might file a card for and asks once. A call per query would be sixty round
 * trips to decide six cards, and a model shown the whole batch can also see
 * which queries are the same searcher twice.
 *
 * `unjudged` MEANS NO CARD HERE, WHICH IS THE OPPOSITE OF THE USUAL LEAN. See
 * `judgeSearchIntent`.
 */
import { judge } from "../models/judge.ts";
import { PORTFOLIO_VENTURE } from "../runtime/budgets.ts";

/** The three fields a venture row carries that can spell its name. */
export type BrandNames = {
  name?: string | null;
  slug?: string | null;
  host?: string | null;
};

/** `brand` is navigation to something of ours; `need` is a description of a
 *  problem or a category. Two words, because a third ("unsure") would be read
 *  downstream as "file it" by anybody who forgot to handle it. */
export const SEARCH_INTENTS = ["brand", "need"] as const;
export type SearchIntent = (typeof SEARCH_INTENTS)[number];

/** A verdict per query, or `unjudged` when no model answered for the batch. */
export type QueryIntent = SearchIntent | "unjudged";

export const BRAND_QUERY_GATE = "board.brand-query";

/** The one fold both sides of every lookup get, so the caller can find its own
 *  row back. Search Console returns the same query with different spacing and
 *  case across properties; this is bookkeeping, not matching. */
export const queryKey = (query: string): string =>
  String(query ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/**
 * THE HOSTNAME A STORED PROPERTY OR VENTURE FIELD MEANS.
 *
 * Parsing, not judging: `sc-domain:freellmapi.co`, `https://freellmapi.co/` and
 * `www.freellmapi.co` are three spellings of one hostname, and which one a row
 * carries depends on which API wrote it.
 */
const hostname = (raw: string | null | undefined): string =>
  String(raw ?? "").trim().toLowerCase()
    .replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").split(/[/?#]/)[0]!.replace(/^www\./, "");

/**
 * THE PART THAT IS A FACT AND NOT A JUDGMENT, so the model is never asked it.
 *
 * `site:freellmapi.co` is a person asking Google to list a site's own pages.
 * That is what the operator DOES; no reading of intent is involved, and there is
 * no page to improve either way. And a query that is exactly one of our
 * hostnames is somebody who typed the address into the search box — an exact
 * string equality between two hostnames, which is checkable, unlike "is this
 * word close enough to our name".
 *
 * Deliberately nothing else. The moment this function starts asking whether a
 * word is NEARLY a hostname it is the edit-distance gate again.
 */
export function navigationalByFact(query: string, brands: readonly BrandNames[]): boolean {
  const raw = queryKey(query);
  if (!raw) return false;
  if (raw.startsWith("site:")) return true;
  const hosts = new Set(brands.map(b => hostname(b.host)).filter(Boolean));
  return hosts.has(hostname(raw));
}

/**
 * HOW MANY QUERIES ONE SWEEP MAY ASK ABOUT.
 *
 * Not a threshold on meaning — a bound on a single reply. The judge discards a
 * reply that does not carry a verdict for every item, and a verdict is roughly
 * thirty tokens of JSON, so a batch of sixty fits inside the workspace's output
 * allowance with room to spare and a batch of six hundred would be refused
 * wholesale, every sweep, forever.
 *
 * The cap is applied to the order the caller gives, so a caller with more
 * queries than this spends the allowance by interleaving its ventures rather
 * than letting the loudest property fill the batch; see `sources.ts`.
 */
export const QUERIES_JUDGED_PER_SWEEP = 60;

const question = [
  "You are triaging Google Search Console queries for a one-person software portfolio. For each query, decide what the searcher was doing.",
  '"brand" — they were navigating to one of the ventures listed below: they typed its name, a misspelling or mistyping of it, its domain, a repository path, or its name with a modifier such as "login", "app", "github", "pricing", "reddit" or "review". A query that names ANY venture on the list is brand, even when it was measured on a different venture\'s property. There is nothing to improve for these: the page the searcher wanted is the page they already got.',
  '"need" — they described a problem, a category, a comparison or a product they wanted, without naming one of the ventures. These are the queries a better page could win.',
  'THE HARD CASE, and the reason this is your judgment and not a spelling comparison: a venture named after the generic phrase it serves. "freellmapi" is brand; "free llm api" is a person describing the category and is a need, as are "best free llm api" and "openrouter alternative". A name typed with a stray space ("freell mapi", "jot thespot") is still a mistyped name and is brand. Judge which of the two the words read as.',
  'WHEN YOU GENUINELY CANNOT TELL, ANSWER "brand". A wrongly filed navigational query becomes a card on the owner\'s board that he has to read and clear by hand, and it is filed permanently. A missed opportunity is offered again on the next sweep.',
].join("\n\n");

/**
 * JUDGE A WHOLE SWEEP'S QUERIES AT ONCE. Keyed by `queryKey`, one entry for
 * every query given, never throwing.
 *
 * WHY `unjudged` MUST MEAN "NO CARD" IN THE CALLER, which is the opposite of
 * the lean `judge` recommends and of what the card gates do. The two directions
 * are not symmetrical here, because the two mistakes are not symmetrical:
 *
 *   - Not filing a real opportunity costs one sweep. The Search Console rows
 *     are stored and the next pass reads the same ones, so the card appears
 *     when a model is reachable again.
 *   - Filing a navigational query writes a receipt into
 *     `board_automation_filings`, keyed by origin and kept after the card is
 *     deleted. The board never offers it again and never re-judges it. The
 *     wrong verdict is permanent, and clearing it is manual work — which is the
 *     exact complaint this gate was built to answer.
 *
 * So a sweep with no model reachable files nothing from search, and says so in
 * `gate_verdicts` rather than quietly filing the whole brand head.
 */
export async function judgeSearchIntent(
  queries: readonly string[],
  brands: readonly BrandNames[],
  opts: { signal?: AbortSignal } = {},
): Promise<Map<string, QueryIntent>> {
  const intents = new Map<string, QueryIntent>();
  const items: { key: string; text: string }[] = [];
  for (const query of queries) {
    const key = queryKey(query);
    if (!key || intents.has(key)) continue;
    if (navigationalByFact(key, brands)) {
      /* Decided in code, so it is not in `gate_verdicts`: a `site:` query and a
         bare hostname explain themselves to anybody reading the query. */
      intents.set(key, "brand");
      continue;
    }
    intents.set(key, "unjudged");
    items.push({ key, text: `The searcher typed: ${query}` });
  }
  if (!items.length) return intents;

  /* THE WHOLE ROSTER, NOT THIS VENTURE'S NAME. A property that ranks for a
     sibling venture's name used to file a card under the wrong venture —
     "neu.ie: improve the page targeting 'freellmapi'" — so the model is shown
     every launched venture and every name it answers to. */
  const roster = brands
    .map(b => [b.name, b.slug && b.slug !== b.name ? `slug ${b.slug}` : "", b.host ? `site ${hostname(b.host)}` : ""]
      .filter(Boolean).join(", "))
    .filter(Boolean);
  const result = await judge({
    gate: BRAND_QUERY_GATE,
    question,
    items: items.slice(0, QUERIES_JUDGED_PER_SWEEP),
    allowed: SEARCH_INTENTS,
    context: roster.length
      ? `THE OWNER'S VENTURES, AND EVERY NAME EACH ONE ANSWERS TO:\n${roster.map(r => `- ${r}`).join("\n")}`
      : "The owner has no launched ventures on record, so no query can be navigational to one.",
    signal: opts.signal,
    /* One sweep over the whole roster: a query is judged against every brand. */
    venture: PORTFOLIO_VENTURE,
  });
  for (const verdict of result.verdicts) intents.set(verdict.key, verdict.verdict);
  return intents;
}
