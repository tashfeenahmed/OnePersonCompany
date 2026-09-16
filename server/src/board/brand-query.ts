/**
 * IS THIS SEARCH QUERY SOMEBODY LOOKING FOR US BY NAME.
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
 * WHAT COUNTS AS THE BRAND
 *
 * Three spellings of one name, because a venture carries three: the display
 * name, the slug, and the host's own label (`freellmapi` out of
 * `freellmapi.co`). All are folded to letters and digits, so `Free LLM API`,
 * `free-llm-api` and `freellmapi` are one token. Tokens under four characters
 * are dropped: `neu` matched half the English language at distance 2 and would
 * have suppressed real queries for every venture that shares those letters.
 *
 * MATCHING, PER QUERY WORD
 *
 * A query is the brand's if ANY of its words is the brand — equal to a token,
 * containing a token of five characters or more (`freellmapi.co`,
 * `myfreellmapi`), or within a small edit distance of one. That word rule is
 * what makes `freellmapi github`, `github freellmapi`, `freellmapi pricing`
 * and `freellmapi login` all navigational: the modifier changes nothing about
 * who is being looked for.
 *
 * THE WHOLE-QUERY RULE, AND WHY IT IS DELIBERATELY WEAK
 *
 * A brand typed with a stray space (`freell mapi`, `free llmapi`) has to be
 * caught too, so the query with its spaces removed is compared as well. But
 * that comparison is dangerous in exactly one direction: a venture named after
 * the generic phrase it serves concatenates to that phrase. `free llm api`
 * joins to `freellmapi` EXACTLY — and `free llm api` is the single most
 * valuable non-brand query FreeLLMAPI has. So the whole-query rule is applied
 * only to queries of one or two words, and only by equality or distance 1. A
 * name split in two is a typo; a name split in three is a person describing
 * the category, and those queries are the ones the growth card is for.
 *
 * The edit distance is written here rather than pulled in: the server has no
 * runtime dependencies beyond hono, and this needs eight lines of it.
 */

/** The three fields a venture row carries that can spell its name. */
export type BrandNames = {
  name?: string | null;
  slug?: string | null;
  host?: string | null;
};

/** Letters and digits only — the one fold both sides of every comparison get. */
const fold = (raw: string | null | undefined): string =>
  String(raw ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Under this, a token is initials or a stub and matches far too much. */
const MIN_TOKEN = 4;

/** Below this length a token is only allowed the tighter distance. */
const TIGHT_DISTANCE_MAX = 6;

/** The shortest token a substring match may use. */
const MIN_CONTAINED = 5;

/**
 * The host's own label: the registrable domain minus its public suffix, so
 * `freellmapi.co` and `blog.example.co.uk` give `freellmapi` and `example`.
 * Kept local rather than imported so this module stays pure string work.
 */
function hostLabel(host: string | null | undefined): string {
  const cleaned = String(host ?? "").trim().toLowerCase()
    .replace(/^sc-domain:/, "").replace(/^https?:\/\//, "").split("/")[0]!.replace(/^www\./, "");
  const parts = cleaned.split(".").filter(Boolean);
  if (parts.length < 2) return parts[0] ?? "";
  /* Drop the suffix: two labels means the first one, three-plus means the one
     before a known two-part suffix, else the second-to-last. */
  const last = parts[parts.length - 1]!, secondLast = parts[parts.length - 2]!;
  const twoPartSuffix = last.length === 2 && ["co", "com", "org", "net", "gov", "edu", "ac"].includes(secondLast);
  return parts[parts.length - (twoPartSuffix ? 3 : 2)] ?? "";
}

/** The distinct brand tokens a venture answers to, longest first. */
export function brandTokens(brand: BrandNames): string[] {
  const tokens = [fold(brand.name), fold(brand.slug), fold(hostLabel(brand.host))]
    .filter(token => token.length >= MIN_TOKEN);
  return [...new Set(tokens)].sort((a, b) => b.length - a.length);
}

/**
 * Damerau-Levenshtein, restricted (optimal string alignment): insertions,
 * deletions, substitutions and the transposition of two ADJACENT characters,
 * which is the one that catches `freellampi` for `freellmapi`. The unrestricted
 * variant differs only on strings that transpose and then edit between the
 * transposed pair; no misspelling of a brand does that.
 *
 * Bails out early once the answer cannot be within `max`, which is what keeps
 * it cheap against a long tail of unrelated queries.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [], prev: number[] = [], row: number[] = [];
  prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    row = new Array<number>(b.length + 1);
    row[0] = i;
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, prev2[j - 2]! + 1);
      row[j] = value;
      if (value < least) least = value;
    }
    if (least > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length]!;
}

/** How far off a token a word may be and still be that token. */
const allowance = (token: string): number => (token.length <= TIGHT_DISTANCE_MAX ? 1 : 2);

/** Is this single folded word the brand, by equality, containment or typo? */
function wordIsBrand(word: string, tokens: readonly string[]): boolean {
  if (!word) return false;
  return tokens.some(token =>
    word === token ||
    (token.length >= MIN_CONTAINED && word.includes(token)) ||
    editDistance(word, token, allowance(token)) <= allowance(token));
}

/**
 * Is this query somebody navigating to this venture rather than describing a
 * need it could meet? See the header for the rules and for why the whole-query
 * comparison is the weak one.
 */
export function isBrandQuery(query: string, brand: BrandNames): boolean {
  const raw = String(query ?? "").trim().toLowerCase();
  if (!raw) return false;
  /* `site:freellmapi.co` is a person listing our own pages. Navigational
     whoever's brand it names, so it does not even need a token to match. */
  if (raw.startsWith("site:")) return true;
  const tokens = brandTokens(brand);
  if (!tokens.length) return false;
  const words = raw.split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some(word => wordIsBrand(word, tokens))) return true;
  if (words.length > 2) return false;
  const joined = words.join("");
  return tokens.some(token => joined === token || editDistance(joined, token, 1) <= 1);
}
