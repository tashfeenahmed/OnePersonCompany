/**
 * REPOSITORY EXTRACTION — the only place on this box that reads what a product
 * IS out of the product itself.
 *
 * WHY THE SOURCE AND NOT THE SITE. `ventures/enrich.ts` reads the home page,
 * and the home page is the product's own MARKETING COPY: what it claims. A
 * route file is what it does. When the two disagree — and they always disagree
 * about capabilities, because a landing page is written once and the code is
 * written every week — nothing on this box could previously tell which was
 * lying, because nothing recorded where a sentence came from.
 *
 * THE GATE IS THE FEATURE, and it is deterministic rather than a prompt
 * instruction. The model is handed material with a LINE NUMBER on every line
 * and told to cite `path:line` for each fact. Every citation is then CHECKED,
 * in code, against the material that was actually fetched: a fact citing a file
 * that was not sent, or a line outside the range that was sent, is REJECTED —
 * not downgraded, not flagged, dropped. A model asked for citations produces
 * citations whether or not it read anything, so the only useful question is
 * whether the thing it cited exists, and that question has a mechanical answer.
 *
 * A SECOND GATE ON DIGITS, carried over from the previous system for its
 * stated reason: a proposed fact carrying a figure that is nowhere in the
 * material is a figure the model produced, and a price a model produced is the
 * single most expensive kind of wrong this feature could ship.
 *
 * THE PROHIBITED INFERENCES, enforced twice — in the prompt and again here,
 * where a prompt cannot be trusted:
 *   * NO AUDIENCE FROM A ROUTE NAME. `/teachers` existing does not mean
 *     teachers use it. `audience` facts are refused from this extractor
 *     entirely; the owner and the measurements are the only sources for one.
 *   * NO REAL CAPABILITY FROM MARKETING COPY. A README paragraph is filed as a
 *     `claim`, never as a `capability`, whatever the model asked for.
 *   * NO NUMBER THAT IS NOT IN THE MATERIAL.
 *
 * NOTHING FROM A REPOSITORY IS EVER EXECUTED. No clone, no install, no build,
 * no hook, no script. GitHub repositories are read through the contents API;
 * a local path is read with `readFileSync` and one `git rev-parse`, invoked
 * through `execFile` with an argument ARRAY so a path can never be a command.
 * Every file that reaches this process is read as text with a byte cap.
 */
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { complete } from "../../models/provider.ts";
import { tokenAccounts } from "../../providers/github.ts";
import { linkedEntities } from "../ventures/links.ts";
import {
  CONFIDENCE,
  KINDS,
  type FactKind,
  type WriteFact,
  markRepo,
  put,
  repoRow,
  setRepo,
} from "./store.ts";
import { db, now, ventureRowById } from "../../db.ts";

/* ------------------------------------------------------------------- caps */

/** One file's worth of evidence. Past this a file is a corpus, not a fact. */
const MAX_FILE_LINES = 120;
const MAX_FILE_CHARS = 12_000;
/** How many files are fetched. Sixteen is four API calls of overhead plus
 *  sixteen reads, which is a rounding error against this box's hourly budget
 *  and is more than enough to describe a product. */
const MAX_FILES = 16;
/** How much of the tree is shown. The tree is EVIDENCE — a path is a fact that
 *  a file exists — so it is citable, which means it has to be bounded. */
const MAX_TREE = 250;
/**
 * THE WHOLE MATERIAL'S CEILING, and it is the cap that actually matters.
 *
 * The per-file caps bound one file; sixteen of them plus a tree is a hundred
 * thousand characters, and the first real extraction on this box proved what
 * that costs: the provider answered with nothing this parser could read, every
 * time, on repository after repository, while the same prompt at a tenth the
 * size came back as clean JSON. A model handed more context than it can hold
 * does not say so — it truncates its own answer, and a truncated JSON object is
 * indistinguishable here from a refusal.
 *
 * Forty-five thousand characters is roughly twelve thousand tokens of input,
 * which every endpoint this box can reach holds comfortably with room for an
 * answer. What does not fit is CUT AT A LINE BOUNDARY and the excerpt records
 * how many lines it actually kept — so a citation into a line that was trimmed
 * away is rejected by the same gate as a citation into a file that was never
 * fetched, which is exactly right: the model did not see it.
 */
const MAX_MATERIAL_CHARS = 45_000;
/** What one extraction may propose. Fewer is better; zero is a valid answer. */
const MAX_PROPOSED = 12;
const HTTP_TIMEOUT_MS = 20_000;
const GIT_TIMEOUT_MS = 10_000;
/**
 * THE WHOLE FETCH'S DEADLINE, as opposed to each call's timeout.
 *
 * Seventeen GitHub calls at a twenty-second timeout each is five and a half
 * minutes in the worst case, on a request the Knowledge tab BLOCKS on with a
 * spinner. Nobody waits that long and nobody should have to: a repository that
 * has taken ninety seconds to hand over sixteen small files is a repository
 * this pass should give up on, file what it has, and say so. What was fetched
 * before the deadline is still evidence, and the excerpts that did not arrive
 * are named in the notes rather than silently missing.
 */
const FETCH_DEADLINE_MS = 90_000;

/** The pseudo-path the file tree is cited by. It is not a file, and it is
 *  named so that a reader of a citation cannot mistake it for one. */
export const TREE_PATH = "<file tree>";

/* ------------------------------------------------------------------ shapes */

/** A run of lines that was actually put in front of the model. `startLine` is
 *  1-based and is what a citation is checked against. */
export type Excerpt = { path: string; startLine: number; lines: string[]; why: string };

export type Material = {
  repo: string;
  kind: "github" | "local";
  /** The commit the material was read at. Null when the tree is not a git
   *  checkout — a local directory can legitimately not be one. */
  commit: string | null;
  excerpts: Excerpt[];
  notes: string[];
};

/* ------------------------------------------------------------ the citation */

/**
 * DOES THIS CITATION NAME SOMETHING THE MODEL WAS ACTUALLY SHOWN?
 *
 * The answer is mechanical and that is the entire point. `path:line` and
 * `path:line-line` are both accepted (a model asked for one line will sometimes
 * give a range and that is not a lie); the path must match a fetched excerpt
 * exactly once leading `./` is stripped, and the line must fall inside the run
 * of lines that was sent. A file that exists in the repository but was NOT
 * fetched fails, deliberately: the question is not whether the file is real, it
 * is whether the model read it.
 *
 * Exported and pure so it can be tested without a repository, a token or a
 * model — which is what makes it a gate rather than an intention.
 */
export function verifyCitation(
  excerpts: Excerpt[],
  citation: string,
): { ok: true; path: string; line: number } | { ok: false; why: string } {
  const raw = String(citation ?? "").trim();
  const m = /^(.+?):(\d+)(?:\s*-\s*(\d+))?$/.exec(raw);
  if (!m) return { ok: false, why: `"${raw.slice(0, 80)}" is not a path:line citation` };
  const path = m[1]!.trim().replace(/^\.\//, "");
  const line = Number(m[2]);

  const mine = excerpts.filter((e) => e.path === path);
  if (!mine.length)
    return { ok: false, why: `nothing called "${path}" was read; the citation names a file that was not fetched` };
  for (const e of mine) {
    const last = e.startLine + e.lines.length - 1;
    if (line >= e.startLine && line <= last) return { ok: true, path, line };
  }
  const ranges = mine.map((e) => `${e.startLine}-${e.startLine + e.lines.length - 1}`).join(", ");
  return {
    ok: false,
    why: `line ${line} of "${path}" was not read; the lines put in front of the model were ${ranges}`,
  };
}

/** Every digit run in the material, so a figure can be checked against it. */
export function materialNumbers(excerpts: Excerpt[]): Set<string> {
  const out = new Set<string>();
  for (const e of excerpts)
    for (const line of e.lines)
      for (const tok of line.match(/\d[\d,._]*/g) ?? [])
        out.add(tok.replace(/[,_]/g, "").replace(/\.0+$/, ""));
  return out;
}

/**
 * Ported from the previous system for its reason: a bullet carrying an
 * invented figure is dropped individually rather than costing the whole answer.
 * Small integers up to twelve are allowed through — "three plans" is prose, not
 * a measurement, and refusing it would reject most honest sentences.
 */
export function numbersGrounded(text: string, known: Set<string>): boolean {
  for (const tok of String(text ?? "").match(/\d[\d,._]*/g) ?? []) {
    const bare = tok.replace(/[,_]/g, "").replace(/\.0+$/, "");
    if (known.has(bare)) continue;
    const n = Number(bare);
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 12) continue;
    return false;
  }
  return true;
}

/* ------------------------------------------------------- choosing the files */

/**
 * WHICH FILES DESCRIBE A PRODUCT.
 *
 * Six families, and each is here because it answers a question the venture
 * record cannot: what it is called and what it is built out of (manifests),
 * what it says it does (README), what it charges (pricing constants), what it
 * talks to (the env example), what changed lately (CHANGELOG), and what exists
 * at all (the tree). Nothing else is fetched — a repository read exhaustively
 * is a repository nobody can afford to read.
 */
const NAMED: { re: RegExp; why: string; kind: FactKind }[] = [
  { re: /^readme(\.[a-z]+)?$/i, why: "what the project says it is", kind: "claim" },
  { re: /^package\.json$/, why: "the Node manifest: name, description, dependencies", kind: "integration" },
  { re: /^pyproject\.toml$/, why: "the Python project manifest", kind: "integration" },
  { re: /^requirements\.txt$/, why: "the Python dependency list", kind: "integration" },
  { re: /^go\.mod$/, why: "the Go module and its dependencies", kind: "integration" },
  { re: /^cargo\.toml$/i, why: "the Rust crate manifest", kind: "integration" },
  { re: /^composer\.json$/, why: "the PHP package manifest", kind: "integration" },
  { re: /^gemfile$/i, why: "the Ruby bundle", kind: "integration" },
  { re: /^changelog(\.[a-z]+)?$/i, why: "what changed, newest first", kind: "capability" },
  { re: /^\.?env\.(example|sample|template)$/i, why: "the services it is configured against", kind: "integration" },
  { re: /^openapi\.(ya?ml|json)$/i, why: "the published API surface", kind: "capability" },
];

/**
 * THE PRICING FAMILY, MATCHED AS WHOLE WORDS.
 *
 * It used to be a substring test, and a substring test on a basename fetches
 * `frontier.ts` (contains "tier"), `planning.md` (contains "plan") and
 * `verification-exec-check-plan.md` — the last of which really did win a slot in
 * a live extraction and got cited as a source for a fact about the product. The
 * budget is sixteen files, so every one of those costs a file that might have
 * been a manifest.
 *
 * So the basename's stem is split into WORDS — on punctuation and on camelCase
 * — and one of them must be exactly a pricing word. `pricing.ts`, `plans.ts`,
 * `billingConfig.ts` and `stripe-prices.json` still match; `frontier` and
 * `planning` no longer do, because "frontier" and "planning" are not "tier" and
 * "plan".
 */
const PRICING_WORDS = new Set([
  "price", "prices", "pricing", "plan", "plans", "tier", "tiers",
  "billing", "subscription", "subscriptions", "checkout",
]);

export function basenameWords(base: string): string[] {
  return base
    .replace(/\.[^.]*$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * Extensions a pricing candidate may have — and `.md` is deliberately NOT one
 * of them. A markdown file with "plan" in its name is a project plan, a release
 * plan or a test plan far more often than it is a price list, and the README
 * and CHANGELOG (which really are prose worth reading) are matched by name in
 * NAMED above rather than by this family.
 */
const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rb", ".php",
  ".json", ".toml", ".yaml", ".yml",
]);
const SKIP_DIR = new Set([
  "node_modules", ".git", "dist", "build", "vendor", "target", ".next", "out",
  "coverage", "__pycache__", ".venv", "venv", ".cache", "tmp", "data",
]);

/** Would this path be worth reading, and why? Null means no. */
export function wanted(path: string): { why: string } | null {
  const parts = path.split("/");
  if (parts.some((p) => SKIP_DIR.has(p))) return null;
  const base = parts[parts.length - 1] ?? "";
  /* Depth three: a manifest lives at the root or one level down in a monorepo,
     and a pricing constant four directories deep is a fixture more often than
     it is a price. */
  if (parts.length > 3) return null;
  for (const n of NAMED) if (n.re.test(base)) return { why: n.why };
  if (
    CODE_EXT.has(extname(base).toLowerCase()) &&
    basenameWords(base).some((w) => PRICING_WORDS.has(w))
  )
    return { why: "its name says it holds prices or plans" };
  return null;
}

/** Named files first, then pricing candidates, so the cap never spends its
 *  slots on six files called `plans.ts` and leaves out the README. */
function rank(path: string): number {
  const base = path.split("/").pop() ?? "";
  const i = NAMED.findIndex((n) => n.re.test(base));
  return i === -1 ? 100 + path.length : i;
}

function excerptOf(path: string, text: string, why: string): Excerpt {
  const lines = text.slice(0, MAX_FILE_CHARS).split(/\r?\n/).slice(0, MAX_FILE_LINES);
  return { path, startLine: 1, lines, why };
}

/* ------------------------------------------------------------------ GitHub */

const GH = "https://api.github.com";

async function ghGet<T>(path: string, token: string | null): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "onepersoncompany-knowledge/1.0",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${GH}${path}`, {
    headers,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { message?: string }).message ?? "";
    } catch {
      /* not JSON; the status is all there is */
    }
    throw new Error(`GitHub ${res.status}${detail ? `: ${detail}` : ""} on ${path}`);
  }
  return (await res.json()) as T;
}

/**
 * A repository through GitHub's own API, with no clone anywhere.
 *
 * The token comes from the github plugin's accounts, and the FIRST account
 * with one is used: this is a read of a repository the owner already told this
 * box about, and walking every account to find which one can see it would be
 * three more calls to answer a question a 404 answers.
 *
 * An unauthenticated read is attempted when there is no token at all, because
 * a public repository is still readable at sixty requests an hour and half the
 * ventures here are public. It is reported in the notes so the reason for a
 * refusal on a private repo is legible.
 */
async function githubMaterial(repo: string, deadline = Date.now() + FETCH_DEADLINE_MS): Promise<Material> {
  const notes: string[] = [];
  const accounts = tokenAccounts("knowledge_extract");
  const token = accounts[0]?.token ?? null;
  if (!token)
    notes.push(
      "no GitHub token on this box, so this was read unauthenticated: public repositories only, at sixty requests an hour.",
    );

  const meta = await ghGet<{ default_branch?: string; description?: string | null }>(
    `/repos/${repo}`,
    token,
  );
  const branch = meta.default_branch ?? "main";
  const commits = await ghGet<{ sha?: string }[]>(
    `/repos/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`,
    token,
  );
  const commit = commits[0]?.sha ?? null;
  if (!commit) throw new Error(`${repo} has no commit on ${branch}; there is nothing to read.`);

  const tree = await ghGet<{ tree?: { path?: string; type?: string }[]; truncated?: boolean }>(
    `/repos/${repo}/git/trees/${commit}?recursive=1`,
    token,
  );
  const paths = (tree.tree ?? [])
    .filter((t) => t.type === "blob" && typeof t.path === "string")
    .map((t) => t.path!)
    .filter((p) => !p.split("/").some((s) => SKIP_DIR.has(s)));
  if (tree.truncated)
    notes.push("GitHub truncated the file tree; this reading is of part of the repository.");

  const excerpts: Excerpt[] = [];
  const picked = paths
    .filter((p) => wanted(p))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_FILES);

  let ranOut = 0;
  for (const p of picked) {
    /* The deadline is checked BETWEEN files rather than enforced with one
       signal across all of them, so a file that has already arrived is never
       thrown away by the clock running out on the next one. */
    if (Date.now() >= deadline) {
      ranOut++;
      continue;
    }
    try {
      const doc = await ghGet<{ content?: string; encoding?: string }>(
        `/repos/${repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}?ref=${commit}`,
        token,
      );
      if (doc.encoding !== "base64" || !doc.content) {
        notes.push(`${p} did not come back as text and was skipped.`);
        continue;
      }
      const text = Buffer.from(doc.content, "base64").toString("utf8");
      excerpts.push(excerptOf(p, text, wanted(p)!.why));
    } catch (err) {
      notes.push(`${p} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (ranOut)
    notes.push(
      `the ${FETCH_DEADLINE_MS / 1000}-second fetch deadline arrived with ${ranOut} file(s) still ` +
        `unread; this reading is of what had already been fetched.`,
    );
  /* The tree LAST, so the files win the budget: a path is one fact and a
     README paragraph is several. */
  excerpts.push(treeExcerpt(paths));
  const fitted = applyBudget(excerpts);
  if (fitted.trimmed)
    notes.push(
      `${fitted.trimmed} excerpt(s) were trimmed or dropped to keep the material under ${MAX_MATERIAL_CHARS.toLocaleString("en")} characters; a citation into a line that was cut is rejected like any other.`,
    );
  return { repo, kind: "github", commit, excerpts: fitted.excerpts, notes };
}

/* ------------------------------------------------------------------- local */

function gitHead(dir: string): Promise<string | null> {
  return new Promise((res) => {
    /* An ARGUMENT ARRAY and never a shell string, so a directory name cannot
       be a command. `rev-parse` runs no hook and executes nothing in the
       tree. */
    execFile(
      "git",
      ["-C", dir, "rev-parse", "HEAD"],
      { timeout: GIT_TIMEOUT_MS, maxBuffer: 1 << 16 },
      (err, stdout) => res(err ? null : stdout.trim() || null),
    );
  });
}

function walk(root: string): string[] {
  const out: string[] = [];
  const stack: [string, number][] = [[root, 0]];
  while (stack.length && out.length < 8000) {
    const [dir, depth] = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= 8000) break;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR.has(e.name) || depth >= 4) continue;
        if (e.name.startsWith(".") && e.name !== ".github") continue;
        stack.push([p, depth + 1]);
        continue;
      }
      if (!e.isFile()) continue;
      out.push(relative(root, p));
    }
  }
  return out.sort();
}

/**
 * IS THIS PATH A REPOSITORY THIS FEATURE MAY READ? Null means yes.
 *
 * The one test, and the reasoning is in `localMaterial` below: it must exist,
 * be a directory, and be a git checkout. Exported so `PUT /api/knowledge/repo`
 * can refuse a typo at the moment it is typed rather than at the first refresh,
 * and so the two places cannot drift into two different rules.
 */
export async function checkLocalRepo(dir: string): Promise<string | null> {
  const root = resolve(dir);
  try {
    if (!statSync(root).isDirectory()) return `${root} is not a directory.`;
  } catch {
    return `There is nothing at ${root} on this machine.`;
  }
  if (!(await gitHead(root)))
    return (
      `${root} is not a git checkout. A local repository has to be one: the refresh rule is ` +
      `"re-read when HEAD moves", and up to ${MAX_FILES} files out of the directory are sent ` +
      `to a model, so this refuses a path that is not a repository rather than reading ` +
      `whatever is there.`
    );
  return null;
}

/**
 * A CHECKOUT ON THIS MACHINE, read as text and nothing else.
 *
 * Exported for the test, which is the only way to assert the local branch
 * without a network: a temporary directory with a README and a manifest in it
 * exercises the walk, the file choice, the budget and the citation gate exactly
 * as a real repository does.
 */
export async function localMaterial(dir: string): Promise<Material> {
  const notes: string[] = [];
  const root = resolve(dir);
  let stats;
  try {
    stats = statSync(root);
  } catch {
    throw new Error(`There is nothing at ${root} on this machine.`);
  }
  if (!stats.isDirectory()) throw new Error(`${root} is not a directory.`);

  /*
    IT HAS TO BE A CHECKOUT, AND THAT IS THE WHOLE BOUND ON A LOCAL PATH.

    A local repository is an absolute path the owner typed. Up to sixteen files
    and a 250-path directory listing out of it are posted to a third-party model
    endpoint, so a typo — `/Users/example`, a project's parent, `/` — would send a
    listing and whatever README and manifest it found off this box. The
    remaining fields were never a credential store (`.env` itself is not matched,
    only `.env.example`), but "it leaks little" is not a bound.

    `git rev-parse HEAD` is the bound, and it costs nothing because the commit
    was already being read: a home directory, `/etc` and a downloads folder are
    not checkouts and are refused here, while every real repository passes. It
    is also the honest requirement rather than an arbitrary one — the refresh
    rule is "re-read when HEAD moves", and a directory with no HEAD is one this
    feature cannot do its job on anyway.

    There is deliberately no allow-list directory setting on top of it. The only
    way a local path is ever set is the owner typing one into `PUT
    /api/knowledge/repo`; a `github` link can never produce one; and the
    `knowledge` skill has no action that sets a repository at all. A second
    setting would be a second thing to get wrong guarding a path the owner
    already had to name.
  */
  const commit = await gitHead(root);
  if (!commit)
    throw new Error(
      `${root} is not a git checkout. A local repository has to be one: the refresh rule is ` +
        `"re-read when HEAD moves", and up to sixteen files out of the directory are sent to a ` +
        `model, so this refuses a path that is not a repository rather than reading whatever ` +
        `is there.`,
    );

  const paths = walk(root);
  const excerpts: Excerpt[] = [];
  const picked = paths
    .filter((p) => wanted(p))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, MAX_FILES);

  for (const p of picked) {
    try {
      const full = join(root, p);
      if (statSync(full).size > MAX_FILE_CHARS * 8) {
        notes.push(`${p} is too large to read as evidence and was skipped.`);
        continue;
      }
      excerpts.push(excerptOf(p, readFileSync(full, "utf8"), wanted(p)!.why));
    } catch (err) {
      notes.push(`${p} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  excerpts.push(treeExcerpt(paths));
  const fitted = applyBudget(excerpts);
  if (fitted.trimmed)
    notes.push(
      `${fitted.trimmed} excerpt(s) were trimmed or dropped to keep the material under ${MAX_MATERIAL_CHARS.toLocaleString("en")} characters; a citation into a line that was cut is rejected like any other.`,
    );
  return { repo: root, kind: "local", commit, excerpts: fitted.excerpts, notes };
}

/**
 * FIT THE EVIDENCE INSIDE THE CEILING, cutting only at line boundaries.
 *
 * Walked in the order the caller assembled — the named files first, the tree
 * last — so what loses the budget is the least informative per byte. An excerpt
 * that gets no room at all is DROPPED rather than included empty, because an
 * empty excerpt in the prompt is a filename the model will cite.
 *
 * Exported and pure: the trimming and the citation gate have to agree about
 * what was sent, and the only way to be sure of that is for both to be
 * testable against the same array.
 */
export function applyBudget(
  excerpts: Excerpt[],
  budget = MAX_MATERIAL_CHARS,
): { excerpts: Excerpt[]; trimmed: number; chars: number } {
  const out: Excerpt[] = [];
  let left = budget;
  let trimmed = 0;
  for (const e of excerpts) {
    /* The header the renderer writes is part of the cost; a hundred characters
       is a generous, deliberately fixed estimate rather than a second render.
       It is charged against a COPY of what is left and only committed when the
       excerpt survives — an excerpt that is dropped must not spend budget, or
       a long tail of skipped files would take the total past its own ceiling. */
    let room = left - (100 + e.path.length + e.why.length);
    if (room < 300) {
      trimmed++;
      continue;
    }
    const lines: string[] = [];
    for (const line of e.lines) {
      const cost = line.length + 8;
      if (cost > room) break;
      room -= cost;
      lines.push(line);
    }
    if (!lines.length) {
      trimmed++;
      continue;
    }
    if (lines.length < e.lines.length) trimmed++;
    left = room;
    out.push({ ...e, lines });
  }
  return { excerpts: out, trimmed, chars: budget - left };
}

/**
 * THE TREE IS EVIDENCE AND IS THEREFORE CITABLE.
 *
 * "There is a file at server/src/routes/stripe.ts" is a verified fact about
 * the product, and it is the only evidence there is for most of what a
 * codebase does. So the tree is handed over as a numbered excerpt like any
 * file, under a pseudo-path that cannot be mistaken for one, and a fact citing
 * `<file tree>:42` is checked exactly the way a fact citing a README is.
 */
function treeExcerpt(paths: string[]): Excerpt {
  return {
    path: TREE_PATH,
    startLine: 1,
    lines: paths.slice(0, MAX_TREE),
    why: "every file in the repository, one per line — a path is evidence that a file exists and nothing more",
  };
}

/* --------------------------------------------------- deterministic readings */

/** The line a substring first appears on, 1-based, or null. */
function lineOf(e: Excerpt, needle: RegExp): number | null {
  for (let i = 0; i < e.lines.length; i++) if (needle.test(e.lines[i]!)) return e.startLine + i;
  return null;
}

const FRAMEWORKS =
  /^(next|react|vue|svelte|angular|express|fastify|koa|nest|hono|astro|remix|nuxt|prisma|drizzle|mongoose|sequelize|stripe|firebase|supabase|tailwindcss|socket\.io|redis|pg|mysql2|django|flask|fastapi|sqlalchemy|celery|openai|anthropic|replicate)$/i;

/**
 * WHAT CODE CAN READ WITHOUT ASKING ANYTHING TO THINK.
 *
 * These run whether or not a model provider is connected, and they are the
 * reason this feature is useful on a box with no model key at all: a package
 * name, a dependency list, an env example and a README's first paragraph are
 * four real facts about a product and none of them needs a completion.
 *
 * They carry `repoDirect` confidence — higher than anything a model produces
 * here — because there is no inference in them. The README paragraph is filed
 * as a `claim` and not a `capability`, on the prohibited inference: a page says
 * what a product claims.
 */
export function directFacts(m: Material): { kind: FactKind; statement: string; citation: string }[] {
  const out: { kind: FactKind; statement: string; citation: string }[] = [];
  const find = (re: RegExp) => m.excerpts.find((e) => re.test(e.path));

  const pkg = find(/^package\.json$/);
  if (pkg) {
    const text = pkg.lines.join("\n");
    let parsed: { name?: string; description?: string; dependencies?: Record<string, string> } = {};
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch {
      /* A manifest truncated at 160 lines does not parse, and that is normal
         rather than an error: the regex readings below still work. */
    }
    const nameLine = lineOf(pkg, /"name"\s*:/);
    if (parsed.name && nameLine)
      out.push({
        kind: "claim",
        statement: `The package is named "${parsed.name}".`,
        citation: `package.json:${nameLine}`,
      });
    const descLine = lineOf(pkg, /"description"\s*:/);
    if (parsed.description && descLine)
      out.push({
        kind: "claim",
        statement: `The manifest describes it as: ${parsed.description}`,
        citation: `package.json:${descLine}`,
      });
    const deps = Object.keys(parsed.dependencies ?? {});
    const named = deps.filter((d) => FRAMEWORKS.test(d));
    const depsLine = lineOf(pkg, /"dependencies"\s*:/);
    if (deps.length && depsLine)
      out.push({
        kind: "integration",
        statement:
          `Runtime dependencies in the manifest include ${(named.length ? named : deps)
            .slice(0, 10)
            .join(", ")}.`,
        citation: `package.json:${depsLine}`,
      });
  }

  const env = find(/env\.(example|sample|template)$/i);
  if (env) {
    const keys = env.lines
      .map((l) => /^\s*([A-Z][A-Z0-9_]{2,})\s*=/.exec(l)?.[1])
      .filter((k): k is string => !!k);
    if (keys.length)
      out.push({
        kind: "integration",
        statement:
          `Configured through ${keys.length} environment setting${keys.length === 1 ? "" : "s"}, ` +
          `including ${keys.slice(0, 8).join(", ")}.`,
        citation: `${env.path}:${env.startLine}`,
      });
  }

  const readme = find(/^readme(\.[a-z]+)?$/i);
  if (readme) {
    /* The first paragraph that is not a heading, a badge row or HTML — the
       tagline. Ported from the previous system, along with its thirty-character
       floor, which was tuned against real READMEs. */
    let i = 0;
    while (i < readme.lines.length) {
      const line = (readme.lines[i] ?? "").trim();
      i++;
      if (!line || line.startsWith("#") || line.startsWith("<") || /^\s*[[!]/.test(line)) continue;
      const flat = line.replace(/^\s*[>*-]\s+/, "").replace(/[[\]()]/g, " ").replace(/\s+/g, " ").trim();
      if (flat.length < 30) continue;
      out.push({
        kind: "claim",
        statement: `The README opens by saying: ${flat.slice(0, 300)}`,
        citation: `${readme.path}:${readme.startLine + i - 1}`,
      });
      break;
    }
  }
  return out;
}

/* ------------------------------------------------------------- the model */

const SYSTEM =
  `You read a software repository and write down what the product IS. You are ` +
  `not a copywriter and you are not guessing at a business.\n\n` +
  `WHAT YOU ARE GIVEN is a set of file excerpts. Every line is numbered. That ` +
  `material is everything you know: there is no web, no memory of this product, ` +
  `and nothing else.\n\n` +
  `EVERY FACT MUST CITE ONE LINE YOU WERE SHOWN, as "path:line" — the path ` +
  `exactly as it appears in the excerpt header, and a line number inside that ` +
  `excerpt. A citation naming a file you were not shown, or a line outside the ` +
  `range you were shown, causes the fact to be DELETED. This is checked in code ` +
  `after you answer; there is nothing to be gained by guessing a plausible one.\n\n` +
  `DO NOT INVENT A NUMBER. Any figure in a statement that is not in the material ` +
  `you were given causes that fact to be deleted.\n\n` +
  `THREE THINGS YOU MAY NOT INFER, and each is checked afterwards:\n` +
  `1. WHO USES IT, from a route name or a directory. "/teachers" existing does ` +
  `not mean teachers use it. Do not write an "audience" fact at all; they are ` +
  `refused from this source.\n` +
  `2. A REAL CAPABILITY, from marketing copy. A README paragraph is what the ` +
  `product CLAIMS; file it as kind "claim".\n` +
  `3. A PAIN POINT, from a feature existing. An export button is not evidence ` +
  `that anybody needed an export.\n\n` +
  `KINDS: capability (what it can do), pricing (what it costs and how it is ` +
  `packaged), integration (what it talks to), limitation (what it cannot do), ` +
  `metric (a figure about the product), claim (what it says about itself).\n\n` +
  `Write AT MOST ${MAX_PROPOSED} facts. Fewer is better. Zero is a valid answer ` +
  `and is better than a padded list. Each statement is ONE sentence, plain, no ` +
  `marketing language, no exclamation marks.\n\n` +
  `ANSWER WITH JSON AND NOTHING ELSE. No preamble, no reasoning, no explanation ` +
  `of what you are about to do, no closing remark. The FIRST character of your ` +
  `answer is "{" and the last is "}". Exactly this shape:\n` +
  `{"facts":[{"kind":"capability","statement":"...","citation":"path:12"}]}`;

function renderMaterial(m: Material): string {
  return m.excerpts
    .map((e) => {
      const last = e.startLine + e.lines.length - 1;
      const body = e.lines.map((l, i) => `${e.startLine + i}| ${l}`).join("\n");
      return `--- ${e.path} (lines ${e.startLine}-${last}) — ${e.why} ---\n${body}`;
    })
    .join("\n\n");
}

/**
 * THE ANSWER, OUT OF WHATEVER SHAPE IT ARRIVED IN.
 *
 * THREE ATTEMPTS, AND THE THIRD IS THE ONE THAT EARNED ITS PLACE. The first two
 * are the usual: the text as sent, then the outermost braces, for an answer
 * wrapped in an apology or a fence. The third is a SALVAGE, and it was added
 * after watching a real extraction fail on a real repository — the endpoint
 * this box happened to be routed to is a reasoning model, it wrote four
 * paragraphs of "We need to extract facts from the provided material" before
 * the JSON, and its answer hit the output ceiling with the object still open.
 * Two hundred lines of a repository had been read for nothing.
 *
 * So a document that will not parse is scanned for FLAT OBJECTS carrying a
 * `citation`, each parsed on its own. That is safe in a way a looser JSON
 * parser would not be: a salvaged object is not trusted any more than a parsed
 * one — it goes through exactly the same gate, its citation is checked against
 * the material, its digits are checked against the material, and an object the
 * truncation cut in half does not parse and is not salvaged. The worst a
 * salvage can do is recover a fact the model actually wrote.
 */
export function tryParse(text: string): { facts?: unknown } | null {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  for (const c of [text, a === -1 || b <= a ? null : text.slice(a, b + 1)]) {
    if (!c) continue;
    try {
      const doc = JSON.parse(c) as { facts?: unknown };
      if (doc && Array.isArray(doc.facts)) return doc;
    } catch {
      /* try the next shape */
    }
  }
  const salvaged: unknown[] = [];
  for (const m of text.match(/\{[^{}]*"citation"[^{}]*\}/g) ?? []) {
    try {
      salvaged.push(JSON.parse(m));
    } catch {
      /* an object the truncation cut in half is not a fact */
    }
  }
  return salvaged.length ? { facts: salvaged } : null;
}

export type Proposal = { kind: FactKind; statement: string; citation: string };

/**
 * THE GATE, applied to whatever the model said.
 *
 * Pure and exported, so the rejection rules can be tested without a model: a
 * fabricated citation, a citation to a file that was not fetched, a line past
 * the end of an excerpt, an invented number and an `audience` fact are the
 * five things this drops, and each drop is counted with its reason so the
 * extraction report can say what happened rather than just how many survived.
 */
export function gate(
  raw: unknown,
  excerpts: Excerpt[],
): { kept: Proposal[]; dropped: Record<string, number> } {
  const kept: Proposal[] = [];
  const dropped: Record<string, number> = {};
  const drop = (why: string) => {
    dropped[why] = (dropped[why] ?? 0) + 1;
  };
  const known = materialNumbers(excerpts);

  if (!Array.isArray(raw)) {
    drop("the answer had no facts array");
    return { kept, dropped };
  }
  for (const item of raw.slice(0, MAX_PROPOSED)) {
    const f = item as { kind?: unknown; statement?: unknown; citation?: unknown };
    const statement = typeof f.statement === "string" ? f.statement.trim() : "";
    const kind = typeof f.kind === "string" ? f.kind.toLowerCase().trim() : "";
    const citation = typeof f.citation === "string" ? f.citation : "";
    if (statement.length < 10) {
      drop("no statement");
      continue;
    }
    if (!(KINDS as readonly string[]).includes(kind)) {
      drop(`not a kind: ${kind.slice(0, 20) || "(blank)"}`);
      continue;
    }
    /* NO AUDIENCE FROM A REPOSITORY. Enforced here rather than only in the
       prompt, because it is the inference a model makes most confidently and
       the one nothing in a codebase can support. */
    if (kind === "audience") {
      drop("audience cannot be read out of source; only the owner or a measurement");
      continue;
    }
    const cite = verifyCitation(excerpts, citation);
    if (!cite.ok) {
      drop(`citation rejected — ${cite.why}`);
      continue;
    }
    if (!numbersGrounded(statement, known)) {
      drop("a figure in the statement is not in the material");
      continue;
    }
    kept.push({ kind: kind as FactKind, statement, citation });
  }
  return { kept, dropped };
}

/* ------------------------------------------------------------ the whole run */

/**
 * WHICH REPOSITORY IS THIS VENTURE'S.
 *
 * The owner's own setting first, then the link table. A `github` link is a
 * hostname match the owner accepted, and several ventures here have four of
 * them, so the FIRST is used and the answer says it was a guess — pointing the
 * venture at one explicitly is a row in `knowledge_repos` and beats it for good.
 */
export function resolveRepo(
  ventureId: string,
): { repo: string; kind: "github" | "local"; via: string } | null {
  const set = repoRow(ventureId);
  if (set)
    return {
      repo: set.repo,
      kind: set.kind === "local" ? "local" : "github",
      via:
        set.source === "link"
          ? "the venture's GitHub link, recorded when it was first read"
          : "the owner's setting",
    };
  const linked = linkedEntities(ventureId, "github");
  if (linked.length)
    return {
      repo: linked[0]!,
      kind: "github",
      via:
        linked.length === 1
          ? "the venture's GitHub link"
          : `the first of ${linked.length} GitHub links (${linked.join(", ")}) — set one explicitly to choose`,
    };
  return null;
}

export type ExtractResult = {
  ok: boolean;
  ventureId: string;
  repo: string | null;
  kind: "github" | "local" | null;
  via: string | null;
  commit: string | null;
  skipped: string | null;
  filesRead: number;
  direct: number;
  proposed: number;
  added: number;
  refreshed: number;
  retired: number;
  dropped: Record<string, number>;
  modelUsed: string | null;
  notes: string[];
  error: string | null;
};

/**
 * READ ONE VENTURE'S REPOSITORY AND FILE WHAT IT SAYS.
 *
 * THE REFRESH RULE, and it is two clauses because a repository has two ways of
 * being unchanged: the stored HEAD still matches, AND no stored fact has passed
 * its `refresh_after`. Either one moving is a reason to read again; neither
 * moving is a reason not to spend a completion. `force` is the button on the
 * page, which exists because a rule whose only trigger is a condition nobody
 * can see is a rule nobody can test.
 *
 * A FACT THAT WAS THERE LAST TIME AND IS NOT NOW IS RETIRED, not deleted and
 * not left standing. A capability removed from the repository is a real change
 * and the honest record of it is a retired fact with a date, which is what a
 * reader asking "did this ever do X" needs.
 *
 * THE MODEL IS OPTIONAL. With no provider connected the deterministic readings
 * still land and the result says the model was not asked. That is a smaller
 * answer, not a failure — and it is the shape every collector on this box has.
 */
/**
 * ONE READ PER VENTURE AT A TIME.
 *
 * The tab's button and the skill's `request_refresh` reach the same function,
 * and two of them on one venture is two sets of GitHub calls, two completions
 * and two passes of the retire loop racing each other over the same rows — the
 * second of which could retire what the first had just filed. In-memory rather
 * than a table because it guards a request in THIS process and a lock that
 * outlived a crash would be a repository nobody could read again.
 */
const reading = new Set<string>();

export class RefreshBusyError extends Error {
  constructor(ventureId: string) {
    super(
      `A repository read is already running for ${ventureId}. It takes a few seconds; ` +
        `wait for it rather than starting a second one over the same facts.`,
    );
    this.name = "RefreshBusyError";
  }
}

export async function refreshRepo(
  ventureId: string,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<ExtractResult> {
  if (reading.has(ventureId)) throw new RefreshBusyError(ventureId);
  reading.add(ventureId);
  try {
    return await refreshRepoInner(ventureId, opts);
  } finally {
    reading.delete(ventureId);
  }
}

async function refreshRepoInner(
  ventureId: string,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<ExtractResult> {
  const out: ExtractResult = {
    ok: false,
    ventureId,
    repo: null,
    kind: null,
    via: null,
    commit: null,
    skipped: null,
    filesRead: 0,
    direct: 0,
    proposed: 0,
    added: 0,
    refreshed: 0,
    retired: 0,
    dropped: {},
    modelUsed: null,
    notes: [],
    error: null,
  };

  const v = ventureRowById(ventureId);
  if (!v) {
    out.error = `No venture with id ${ventureId}.`;
    return out;
  }
  const target = resolveRepo(ventureId);
  if (!target) {
    out.error =
      `No repository is mapped to ${v.name}. Link one on the Connections tab, or set one ` +
      `on the Knowledge tab — "owner/name" for GitHub, or an absolute path on this machine.`;
    return out;
  }
  out.repo = target.repo;
  out.kind = target.kind;
  out.via = target.via;

  /* The setting row is created on first use when the repo came from the link
     table, so the HEAD and the last error have somewhere to live. It records
     what was USED, which is what a reader of the page needs to see. */
  if (!repoRow(ventureId))
    setRepo(ventureId, target.repo, target.kind, target.via.startsWith("the owner") ? "owner" : "link");
  const stored = repoRow(ventureId)!;

  let material: Material;
  try {
    material =
      target.kind === "local"
        ? await localMaterial(target.repo)
        : await githubMaterial(target.repo, Date.now() + FETCH_DEADLINE_MS);
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    markRepo(ventureId, { error: out.error });
    return out;
  }
  out.commit = material.commit;
  out.notes = material.notes;
  out.filesRead = material.excerpts.length;

  if (!opts.force && material.commit && stored.head === material.commit) {
    const anyStale = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM knowledge_facts
            WHERE venture_id = ? AND tier = 'repo' AND status = 'active'
              AND refresh_after IS NOT NULL AND refresh_after < ?`,
        )
        .get(ventureId, now()) as { n: number }
    ).n;
    if (!anyStale) {
      out.ok = true;
      out.skipped = `HEAD is still ${material.commit.slice(0, 7)} and nothing has expired; the repository was not re-read.`;
      markRepo(ventureId, { error: null, note: out.skipped });
      return out;
    }
  }

  /* --- the deterministic readings, then the model's, both through the gate - */
  const direct = directFacts(material);
  const checked = direct.filter((f) => verifyCitation(material.excerpts, f.citation).ok);
  out.direct = checked.length;

  let proposals: Proposal[] = [];
  let modelAnswered = false;
  try {
    /* The provider's own model — the one model this box uses for everything.
       A reasoning model routed here can spend its output ceiling thinking and
       return nothing; that case is handled below by the salvage parser and by
       reporting the first line of what came back, not by a second model. */
    const reply = await complete(
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content:
            `PRODUCT: ${v.name}${v.website ? ` (${v.website})` : ""}\n` +
            `REPOSITORY: ${material.repo}${material.commit ? ` at ${material.commit}` : ""}\n\n` +
            `THE MATERIAL, and it is all of it:\n\n${renderMaterial(material)}`,
        },
      ],
      { signal: opts.signal },
    );
    out.modelUsed = reply.model ?? reply.provider;
    const parsed = tryParse(reply.text);
    const g = gate(parsed?.facts, material.excerpts);
    proposals = g.kept;
    out.dropped = g.dropped;
    /* The model was asked AND its answer was readable. Both halves matter to the
       retire rule below: a provider that 502s and a provider that returns four
       paragraphs of prose are both "the model did not tell us what this
       repository contains", and neither is evidence that a capability is gone. */
    modelAnswered = Boolean(parsed && Array.isArray(parsed.facts));
    /* WHAT IT ACTUALLY SAID, when nothing could be read out of it. "the answer
       had no facts array" is a count and not a diagnosis; a refusal, a
       truncation and an apology are three different problems with three
       different fixes, and the only way to tell them apart is the first line
       of what came back. Truncated hard, because this is a note on a page. */
    if (!parsed || !Array.isArray(parsed.facts))
      out.notes.push(
        `the model answered with something this parser could not read; it began: ${reply.text
          .trim()
          .slice(0, 240)
          .replace(/\s+/g, " ")}`,
      );
  } catch (err) {
    /* A missing provider is a documented state and not a failure: the direct
       readings are already worth filing and the note says the rest was not
       asked for. */
    out.notes.push(
      `no model reading this time — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  out.proposed = proposals.length;

  /* ------------------------------------------------------------ the writes */
  /* The confidence travels with the row because it is what says WHICH READER
     produced it: `repoDirect` came from code walking the files, `repoModel`
     from the completion. The retire rule below turns on that distinction. */
  const before = db
    .prepare(
      "SELECT id, confidence FROM knowledge_facts WHERE venture_id = ? AND tier = 'repo' AND status = 'active'",
    )
    .all(ventureId) as unknown as { id: string; confidence: number }[];
  const seen = new Set<string>();

  const write = (f: { kind: FactKind; statement: string; citation: string }, confidence: number) => {
    const w: WriteFact = {
      ventureId,
      kind: f.kind,
      statement: f.statement,
      tier: "repo",
      sourceType: "repo",
      sourceRef: `${material.repo} ${f.citation}`,
      sourceCommit: material.commit,
      confidence,
      createdBy: "agent",
    };
    const r = put(w);
    seen.add(r.id);
    if (r.outcome === "added") out.added++;
    else out.refreshed++;
  };

  for (const f of checked) write(f, CONFIDENCE.repoDirect);
  for (const f of proposals) write(f, CONFIDENCE.repoModel);

  /*
    A READER ONLY RETIRES WHAT IT IS RESPONSIBLE FOR, AND ONLY WHEN IT RAN.

    There are two readers behind the `repo` tier and they fail independently.
    The deterministic one walks files and always runs; if it produced nothing at
    all the fetch itself failed and nothing is retired. The MODEL one is the one
    that goes off this box, and it 502s, rate-limits and answers with prose —
    all three of which happened during this feature's own verification. Retiring
    on `seen.size` alone meant the deterministic readings landing were enough to
    retire every model-tier fact the moment the provider hiccuped, and the next
    success re-filed them as new rows.

    So: direct facts are retired against a pass where direct facts were read, and
    model facts only against a pass where the model actually answered. The
    confidence on the row is the reader's signature.
  */
  const directRan = checked.length > 0;
  if (!directRan)
    out.notes.push(
      "this reading produced no facts of its own, so nothing already on file was retired — an empty read is not evidence that a capability is gone.",
    );
  if (!modelAnswered)
    out.notes.push(
      "the model did not answer readably this time, so nothing it had filed before was retired.",
    );
  for (const row of before) {
    if (seen.has(row.id)) continue;
    const byModel = row.confidence <= CONFIDENCE.repoModel;
    if (byModel ? !modelAnswered : !directRan) continue;
    db.prepare(
      "UPDATE knowledge_facts SET status = 'retired' WHERE id = ? AND status = 'active'",
    ).run(row.id);
    out.retired++;
  }

  markRepo(ventureId, {
    head: material.commit,
    extractedAt: now(),
    error: null,
    note:
      `${out.added} added, ${out.refreshed} refreshed, ${out.retired} retired from ` +
      `${out.filesRead} excerpt(s)${out.modelUsed ? ` with ${out.modelUsed}` : " with no model"}.`,
  });
  out.ok = true;
  return out;
}
