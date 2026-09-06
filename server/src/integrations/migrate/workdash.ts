/**
 * READING A WORKDASH DATA DIRECTORY, and refusing the parts that are secrets.
 *
 * WHAT A WORKDASH DATA DIRECTORY LOOKS LIKE. It is FLAT. There is no `data/`
 * and no `state/`: `/opt/workdash` holds about seventy `*.json` files side by
 * side — `kanban.json`, `chats.json`, `agent-memory.json`, `goals.json`,
 * `outcomes.json`, `studio.json`, `outbox.json`, `projects-info.json`,
 * `actions.json` — plus two SQLite databases (`history.db`, `fleet-minute.db`),
 * a handful of asset directories (`studio/`, `studio/refs/`, `studio/logos/`,
 * `studio/ugc/`), and a `dist/api/` of collector output that is a BUILD
 * ARTIFACT served by a web server. The path is not fixed by a single variable:
 * every module resolves its own file beside `research.json`, so a directory is
 * identified here by the files in it rather than by its name.
 *
 * THE HISTORY IS READ FROM `dist/api/history.json` AND NOT FROM `history.db`.
 * Both hold it; the JSON is what WorkDash itself hands to its own consumers,
 * it is downsampled to one row per day, and it is the shape whose column
 * meanings are written down. Reading the SQLite file directly would mean this
 * importer holding an opinion about eighteen table schemas it cannot verify,
 * on a file it is not allowed to open for writing, for figures that all land in
 * migrate_history anyway. If the export is missing, that is said and the
 * history kind is skipped — it is not silently substituted.
 *
 * NO CREDENTIAL IS EVER READ, COPIED OR PARSED. Not into memory, not into a
 * problem message, not into a batch's counts. The deny list below is a superset
 * of WorkDash's own backup deny list, and it is a superset ON PURPOSE: that
 * list has known gaps (`adsense-token.json` does not match `*-token`;
 * `reddit-app.json` and `*-secret` match nothing in it), and a migration is
 * exactly the moment those gaps would turn into a plaintext key sitting in a
 * second application's data directory forever. What the owner gets instead is a
 * LIST OF PLUGINS TO RECONNECT, which is the only correct migration path for a
 * secret: it goes through the vault, in the UI, once, deliberately.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/* ------------------------------------------------------------ deny list */

/**
 * Anything matching these is not opened. Globs, matched on the basename,
 * except the ones with a slash, which are directories.
 *
 * `vault.json` IS ON THIS LIST even though it is ciphertext and WorkDash's own
 * backup takes it. The reasoning that makes it safe there — the key never
 * leaves the box — is exactly what makes it pointless here: this box cannot
 * decrypt it and has no use for a blob it cannot read, so carrying it across
 * would move a file of secrets one machine closer to somewhere for no benefit.
 */
export const DENY: RegExp[] = [
  /^vault\.(json|key)$/i,
  /^service-key$/i,
  /^auth\.json$/i,
  /^telegram-allowed$/i,
  /^secret-access\.log$/i,
  /-key$/i,
  /-key\.json$/i,
  /-token$/i,
  /-token\.json$/i,
  /-secret$/i,
  /^gmail-.*\.json$/i,
  /^resend-keys\.json$/i,
  /^reddit-app\.json$/i,
  /\.(p8|pem|key|env)$/i,
  /^\.env/i,
];

export const DENY_DIRS = ["gmail-accounts", "backups", "node_modules", "__pycache__", ".git", ".claude"];

export function denied(name: string): boolean {
  const base = basename(name);
  return DENY.some((re) => re.test(base));
}

/**
 * Which plugins the owner has to reconnect by hand, derived from the
 * credential files that were FOUND AND NOT OPENED.
 *
 * Derived rather than listed, so the sentence is about this directory and not
 * about WorkDash in general: an install that never connected Meta should not be
 * told to go and reconnect Meta.
 */
const RECONNECT: { file: RegExp; plugin: string }[] = [
  { file: /^cf-token$/i, plugin: "Cloudflare" },
  { file: /^stripe-key$/i, plugin: "Stripe" },
  { file: /^meta-(token|app)$/i, plugin: "Meta (ads and pages)" },
  { file: /^github-token$/i, plugin: "GitHub" },
  { file: /^hetzner-token$/i, plugin: "Hetzner" },
  { file: /^(dynadot|spaceship)-(key|secret)$/i, plugin: "the domain registrars" },
  { file: /^openrouter-key$/i, plugin: "OpenRouter" },
  { file: /^openai-admin-key$/i, plugin: "OpenAI (organisation costs)" },
  { file: /^replicate-token$/i, plugin: "Replicate (Studio images)" },
  { file: /^(pexels|pixabay)-key$/i, plugin: "the stock image providers" },
  { file: /^searxng-key$/i, plugin: "SearXNG" },
  { file: /^freellmapi-key$/i, plugin: "the model provider" },
  { file: /^bing-key$/i, plugin: "Bing" },
  { file: /^(linkedin|tiktok)-client-(id|key|secret)$/i, plugin: "the social publishing apps" },
  { file: /^telegram-token$/i, plugin: "Telegram" },
  { file: /^gsc-key\.json$/i, plugin: "Google Search Console" },
  { file: /^play-key\.json$/i, plugin: "Google Play" },
  { file: /^asc-key\.p8$/i, plugin: "App Store Connect" },
  { file: /^gmail-(token|client)\.json$/i, plugin: "Gmail" },
  { file: /^resend-keys\.json$/i, plugin: "Resend" },
  { file: /^adsense-token\.json$/i, plugin: "AdSense" },
  { file: /^(ob1|example-app-1)-admin-token$/i, plugin: "the product admin endpoints (as product endpoint accounts)" },
  { file: /^reddit-app\.json$/i, plugin: "Reddit" },
];

/* ------------------------------------------------------------- the read */

export type Doc = { name: string; value: Record<string, unknown> | null; error: string | null };

/** How much of one state file is read. WorkDash's largest is `users.json` at a
 *  few hundred KB and its `chats.json` is capped at sixty conversations; ten
 *  megabytes is far past anything either produces and still a bound, so a
 *  directory pointed at by mistake cannot exhaust memory. */
const MAX_FILE = 10 * 1024 * 1024;

function readJson(dir: string, name: string): Doc {
  if (denied(name)) return { name, value: null, error: "refused: this is a credential file and is never opened." };
  const file = join(dir, name);
  if (!existsSync(file)) return { name, value: null, error: null };
  let size = 0;
  try {
    size = statSync(file).size;
  } catch (err) {
    return { name, value: null, error: err instanceof Error ? err.message : String(err) };
  }
  if (size > MAX_FILE)
    return { name, value: null, error: `it is ${Math.round(size / 1024 / 1024)} MB, past the ${MAX_FILE / 1024 / 1024} MB this reads.` };
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return { name, value: null, error: "it parsed, but not as a JSON object — every WorkDash state file is an object with a named array inside it." };
    return { name, value: parsed as Record<string, unknown>, error: null };
  } catch (err) {
    return { name, value: null, error: `it could not be read as JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export type Source = {
  dir: string;
  /** True when this looks like a WorkDash directory at all. */
  recognised: boolean;
  /** Which of the state files are present. */
  present: string[];
  /** Credential files found and deliberately NOT opened. */
  secrets: string[];
  /** The plugins those secrets belong to, in the owner's words. */
  reconnect: string[];
  docs: Record<string, Doc>;
  /** dist/api/history.json, the exported metric series. */
  history: Record<string, unknown> | null;
  historyNote: string | null;
  /** Asset directories that exist. */
  assets: { studio: string | null; refs: string | null; logos: string | null; ugc: string | null };
  problems: string[];
};

/** The state files this importer knows how to read. Anything else in the
 *  directory is left alone and not counted as a failure — WorkDash has about
 *  seventy and most of them are collector caches this box collects for itself. */
export const STATE_FILES = [
  "projects-info.json",
  "kanban.json",
  "chats.json",
  "agent-memory.json",
  "goals.json",
  "outcomes.json",
  "actions.json",
  "studio.json",
  "outbox.json",
] as const;

/**
 * One directory, opened.
 *
 * NOTHING HERE THROWS. A missing file, an unreadable one, a directory that is
 * not a WorkDash install at all — each is a sentence, because the caller is a
 * dry run whose whole job is to say what it found before anything is written.
 */
export function readSource(dir: string): Source {
  const problems: string[] = [];
  const docs: Record<string, Doc> = {};
  const present: string[] = [];

  if (!existsSync(dir) || !statSync(dir).isDirectory())
    return {
      dir, recognised: false, present: [], secrets: [], reconnect: [], docs: {},
      history: null, historyNote: null,
      assets: { studio: null, refs: null, logos: null, ugc: null },
      problems: [`${dir} is not a directory.`],
    };

  for (const name of STATE_FILES) {
    const doc = readJson(dir, name);
    docs[name] = doc;
    if (doc.value) present.push(name);
    else if (doc.error) problems.push(`${name}: ${doc.error}`);
  }

  /* THE SECRETS ARE LISTED BY NAME AND NOT BY CONTENT. `readdirSync` gives the
     names; nothing below opens one. */
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    problems.push(`the directory could not be listed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const secrets = entries.filter((e) => denied(e)).sort();
  if (entries.includes("gmail-accounts")) secrets.push("gmail-accounts/ (a directory of tokens)");
  const reconnect = [
    ...new Set(
      RECONNECT.filter((r) => entries.some((e) => r.file.test(e))).map((r) => r.plugin),
    ),
  ];

  /* dist/api/history.json — a build artifact, and read as one. */
  let history: Record<string, unknown> | null = null;
  let historyNote: string | null = null;
  const exported = join(dir, "dist", "api", "history.json");
  if (existsSync(exported)) {
    const doc = readJson(join(dir, "dist", "api"), "history.json");
    if (doc.value) history = doc.value;
    else historyNote = doc.error;
  } else {
    historyNote =
      `There is no dist/api/history.json here. That file is WorkDash's own exported metric history and it is a BUILD ARTIFACT — ` +
      `it lives beside a web root and is commonly not kept. history.db holds the same figures and is not read: doing so would mean ` +
      `holding an opinion about eighteen table schemas for rows that all land in migrate_history anyway.`;
  }

  const dirOf = (...parts: string[]) => {
    const p = join(dir, ...parts);
    return existsSync(p) && statSync(p).isDirectory() ? p : null;
  };

  const recognised = present.length > 0 || history !== null;
  if (!recognised)
    problems.push(
      `Nothing in ${dir} looks like WorkDash state. It should hold ${STATE_FILES.slice(0, 4).join(", ")} and the rest beside each other — ` +
        `WorkDash's data directory is FLAT, so point this at /opt/workdash itself and not at a parent or at the repository.`,
    );

  return {
    dir,
    recognised,
    present,
    secrets,
    reconnect,
    docs,
    history,
    historyNote,
    assets: {
      studio: dirOf("studio"),
      refs: dirOf("studio", "refs"),
      logos: dirOf("studio", "logos"),
      ugc: dirOf("studio", "ugc"),
    },
    problems,
  };
}

/** One named array out of one state file, or an empty list. WorkDash keeps
 *  almost nothing as a bare array — every file is an object with the array
 *  under a key — precisely so an empty parse degrades to "no rows" rather than
 *  "no file", and this preserves that. */
export function list(source: Source, file: string, key: string): Record<string, unknown>[] {
  const doc = source.docs[file];
  const value = doc?.value?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v));
}
