/**
 * `opc` — THE DASHBOARD'S DATA, AS A COMMAND.
 *
 *   opc                          what is connected, one line each
 *   opc help <id>                one skill: what it is, its views, its actions, its rules
 *   opc <id> [view] [--p v …]    read a document (a GET; changes nothing)
 *   opc <id> <action> --p v …    change something (a POST; only what the pack allows)
 *   opc present                  how to draw cards, charts and tables in the chat
 *
 * WHY A COMMAND AND NOT A TOOL. The agent that reads this dashboard's data is
 * Hermes, and Hermes has a terminal. Every other door — a curl in a pack, an
 * MCP subprocess per integration — put a second thing between the agent and
 * the figure: a URL to assemble, a query string to spell, a JSON-RPC child to
 * keep alive. A command is what a terminal is FOR. `opc stripe --days 30` is
 * one token the model has seen in its pack, cannot misquote the base URL of,
 * and gets a readable error from when it is wrong.
 *
 * IT IS A CLIENT OF THE API AND HOLDS NOTHING OF ITS OWN. No registry, no
 * database handle, no rules of its own to fall out of step with the routes: it
 * asks `/api/skills` what exists and forwards to `/api/skills/<id>` for the
 * document, which is passed through VERBATIM, status code included — the same
 * contract the proxy route keeps with the routes behind it. A plugin connected
 * while the agent is running is there on the next `opc` with nothing restarted.
 *
 * READS AND WRITES ARE TOLD APART BY THE CATALOG, NOT BY A FLAG. The word after
 * the id is looked up: a view key is a read, an action key is a write, and a
 * word that is neither is refused with the list of both — never guessed to be
 * one or the other, because guessing "create_card" is a view leaves the agent
 * believing it wrote something.
 *
 * NOTHING HERE PARSES A RULE. The honesty rules travel in the pack the agent
 * read before it typed this, and `opc help <id>` prints them again, verbatim
 * from the catalog. The one thing this file adds to the wire is typing: a
 * parameter the catalog calls a number is sent as a number, because the routes
 * refuse a quoted "1" and an agent that copied an example should not learn
 * that the example was wrong.
 *
 * Zero dependencies. `fetch` is Node's own. Run as
 * `node --experimental-strip-types src/cli/opc.ts` — or as `opc`, the two-line
 * wrapper skills/cli.ts writes for the agent.
 */
import { PRESENT_GUIDE } from "../skills/present.ts";

const API = (process.env.OPC_API ?? "http://127.0.0.1:8787").replace(/\/+$/, "");

/**
 * THE SERVICE KEY, from the environment.
 *
 * The wrapper `opc` is invoked through reads it out of `server/data/service-key`
 * on every run and exports it here, so rotating the key is replacing a file.
 * Empty is the ordinary case on a box with no password: the header is sent
 * anyway, the gate is not looking, and nothing has to know which world it is
 * in. See server/src/auth.ts.
 */
const KEY = (process.env.OPC_KEY ?? "").trim();
const AUTH: Record<string, string> = KEY ? { "x-opc-key": KEY } : {};


/* ---------------------------------------------------------------- catalog */

type Param = {
  name: string;
  type: "number" | "string";
  required: boolean;
  default: number | string | null;
  in: "query" | "path" | "body";
  about: string;
  exampled?: boolean;
};
type View = { key: string; route: string; about: string; params: Param[] };
type Action = {
  key: string;
  method: string;
  route: string;
  call: string;
  about: string;
  destructive: boolean;
  params: Param[];
};
type CatalogSkill = {
  id: string;
  title: string;
  connected: boolean;
  plugins: string[];
  connectedPlugins: string[];
  about: string;
  rules: string[];
  views: View[];
  actions: Action[];
  asks: string[];
};
type Catalog = {
  baseUrl: string;
  rules: string[];
  skills: CatalogSkill[];
  disconnected: { id: string; title: string; needs: string[] }[];
};

async function catalog(): Promise<Catalog> {
  let res: Response;
  try {
    res = await fetch(`${API}/api/skills`, { headers: AUTH, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Fail(
      `The dashboard is not answering at ${API} (${err instanceof Error ? err.message : String(err)}). ` +
        `Nothing can be read until it is; do not answer from memory.`,
      2,
    );
  }
  if (!res.ok) throw new Fail(`${API}/api/skills answered HTTP ${res.status}.`, 2);
  return (await res.json()) as Catalog;
}

/* ------------------------------------------------------------------- argv */

class Fail extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.code = code;
  }
}

type Parsed = {
  words: string[];
  flags: Record<string, string>;
  raw: boolean;
  json: string | null;
  help: boolean;
};

/**
 * `--key value`, `--key=value`, and bare words in order. A value that starts
 * with `--` is a value when the flag was written `--key=--value`, and a flag
 * with no value gets the empty string — the catalog says which parameters are
 * required, so an empty one fails there with the right sentence.
 */
function parse(argv: string[]): Parsed {
  const out: Parsed = { words: [], flags: {}, raw: false, json: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--raw") out.raw = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = argv[++i] ?? "";
    else if (a.startsWith("--json=")) out.json = a.slice(7);
    else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 2) out.flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out.flags[a.slice(2)] = next;
          i++;
        } else out.flags[a.slice(2)] = "";
      }
    } else out.words.push(a);
  }
  return out;
}

/* ------------------------------------------------------------------ print */

const USAGE = `\
opc — this dashboard's own live data, as a command

  opc                         list what is connected (and what is not)
  opc help <id>               one skill: what it reads, its parameters, its actions, its rules
  opc <id> [view] [--p v …]   read a document. A GET: changes nothing.
  opc <id> <action> --p v …   change something. A POST, only where the skill allows it.
  opc present                 how to draw cards, charts, bars, meters and tables in the chat

  --raw          print the document compact rather than indented
  --json '{…}'   the whole body of an action as one JSON object (flags still apply on top)

Reads pass the document through exactly as the dashboard answered it, status
code and all; an error is printed and the exit code is 2. A parameter the skill
does not have is refused rather than ignored, because a silently dropped
\`--month=august\` is how a 30-day window gets captioned as August.`;

function fmtValue(p: Param): string {
  if (p.required) return "required";
  return p.default === null ? "—" : String(p.default);
}

function paramTable(params: Param[]): string[] {
  if (!params.length) return [];
  const w = Math.max(...params.map((p) => p.name.length), 4);
  const out = [`  ${"flag".padEnd(w + 2)}  ${"default".padEnd(9)}  meaning`];
  for (const p of params)
    out.push(`  ${`--${p.name}`.padEnd(w + 2)}  ${fmtValue(p).padEnd(9)}  ${p.about}`);
  return out;
}

function example(id: string, key: string | null, params: Param[], flagsFor: (p: Param) => boolean) {
  const flags = params
    .filter(flagsFor)
    .map((p) => `--${p.name} ${p.type === "number" ? (p.default ?? 1) : p.default ? JSON.stringify(String(p.default)) : '"…"'}`)
    .join(" ");
  return `opc ${id}${key ? ` ${key}` : ""}${flags ? ` ${flags}` : ""}`;
}

function helpFor(s: CatalogSkill, universal: string[]): string {
  const out: string[] = [];
  out.push(`${s.id} — ${s.title}`);
  out.push("");
  out.push(s.about);
  out.push("");
  out.push(`Answers questions like: ${s.asks.map((q) => `"${q}"`).join(" / ")}`);
  out.push("");
  out.push("READ (a GET; changes nothing):");
  s.views.forEach((v, i) => {
    out.push(`  ${example(s.id, i === 0 ? null : v.key, v.params, () => true)}`);
    out.push(`      ${v.about}`);
    for (const line of paramTable(v.params)) out.push(`    ${line}`);
  });
  if (s.actions.length) {
    out.push("");
    out.push("ACT (a POST; changes the owner's own data — only when asked for that exact change):");
    for (const a of s.actions) {
      out.push(`  ${example(s.id, a.key, a.params, (p) => p.required || p.exampled === true)}${a.destructive ? "   ← no undo" : ""}`);
      out.push(`      ${a.about}`);
      for (const line of paramTable(a.params)) out.push(`    ${line}`);
    }
  } else {
    out.push("");
    out.push("This skill has nothing that writes.");
  }
  out.push("");
  out.push("REPORT IT HONESTLY — these are not optional:");
  for (const r of s.rules) out.push(`  - ${r}`);
  out.push("And for every document on this dashboard:");
  for (const r of universal) out.push(`  - ${r}`);
  return out.join("\n");
}

function listing(cat: Catalog): string {
  const out: string[] = [];
  out.push(`Connected (${cat.skills.length}) — \`opc help <id>\` for the parameters and the rules:`);
  const w = Math.max(...cat.skills.map((s) => s.id.length), 2);
  for (const s of cat.skills) {
    const params = s.views[0]?.params.map((p) => `--${p.name}`).join(" ") ?? "";
    const writes = s.actions.length ? `  +writes: ${s.actions.map((a) => a.key).join(", ")}` : "";
    out.push(`  ${s.id.padEnd(w)}  ${s.title}${params ? `  [${params}]` : ""}${writes}`);
  }
  if (cat.disconnected.length) {
    out.push("");
    out.push("Not connected — there is no figure here, and \"nobody connected it\" is the honest answer:");
    for (const d of cat.disconnected) out.push(`  ${d.id.padEnd(w)}  ${d.title}  (needs ${d.needs.join(" or ")})`);
  }
  out.push("");
  out.push("`opc present` says how to show figures as cards, charts and tables in the chat.");
  return out.join("\n");
}

/* ------------------------------------------------------------------ calls */

/** The document, as the dashboard answered it. Indented when it is JSON and
 *  `--raw` was not asked for; otherwise byte for byte. */
async function passThrough(res: Response, raw: boolean): Promise<number> {
  const text = await res.text();
  let out = text;
  if (!raw) {
    try {
      out = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* not JSON — printed as it came */
    }
  }
  const stream = res.ok ? process.stdout : process.stderr;
  stream.write(out.endsWith("\n") ? out : `${out}\n`);
  /*
    THE SIZE, SAID OUT LOUD WHEN IT MATTERS. Hermes' terminal tool truncates
    long output and files the rest away where the model does not look, so a
    document past this size is a document the agent will read the front of and
    believe it read whole — which is how a venture at the end of a list came
    to be reported as not existing. The note goes to stderr, which the tool
    shows beside stdout, and names the way out.
  */
  if (res.ok && out.length > BIG_DOC_BYTES)
    process.stderr.write(
      `note: this document is ${Math.round(out.length / 1024)} KB. Long terminal output is ` +
        `truncated for you, so prefer a narrower view (\`opc help <id>\`) or pick the ` +
        `fields you need: \`opc … --raw | jq '.path.to.it'\`.\n`,
    );
  return res.ok ? 0 : 2;
}

/** Past this, the note above is printed. Well under the terminal tool's own
 *  cut, so the note is the first thing lost rather than the last. */
const BIG_DOC_BYTES = 24 * 1024;

function typed(p: Param, v: string): string | number {
  if (p.type !== "number") return v;
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n))
    throw new Fail(`--${p.name} takes a number and "${v}" is not one.`, 1);
  return n;
}

async function read(s: CatalogSkill, v: View, flags: Record<string, string>, raw: boolean) {
  const known = new Set(v.params.map((p) => p.name));
  const unknown = Object.keys(flags).filter((k) => !known.has(k));
  if (unknown.length)
    throw new Fail(
      `${s.id} ${v.key === s.views[0]?.key ? "" : `${v.key} `}has no parameter ${unknown.map((k) => `--${k}`).join(", ")}. ` +
        (v.params.length ? `It takes: ${v.params.map((p) => `--${p.name}`).join(", ")}.` : "It takes none."),
      1,
    );
  for (const p of v.params)
    if (p.required && !(flags[p.name] ?? "").trim()) throw new Fail(`--${p.name} is required: ${p.about}`, 1);
  const q = new URLSearchParams();
  if (v.key !== s.views[0]?.key) q.set("view", v.key);
  for (const [k, val] of Object.entries(flags)) q.set(k, String(typed(v.params.find((p) => p.name === k)!, val)));
  const qs = q.toString();
  const res = await fetch(`${API}/api/skills/${encodeURIComponent(s.id)}${qs ? `?${qs}` : ""}`, {
    headers: AUTH,
    signal: AbortSignal.timeout(60_000),
  });
  return passThrough(res, raw);
}

async function act(s: CatalogSkill, a: Action, parsed: Parsed) {
  let body: Record<string, unknown> = {};
  if (parsed.json !== null) {
    try {
      const doc = JSON.parse(parsed.json) as unknown;
      if (typeof doc !== "object" || doc === null || Array.isArray(doc))
        throw new Error("not an object");
      body = doc as Record<string, unknown>;
    } catch {
      throw new Fail("--json must be one JSON object, like '{\"title\":\"…\"}'.", 1);
    }
  }
  const known = new Set(a.params.map((p) => p.name));
  const unknown = [...Object.keys(parsed.flags), ...Object.keys(body)].filter((k) => !known.has(k));
  if (unknown.length)
    throw new Fail(
      `${s.id} ${a.key} has no parameter ${[...new Set(unknown)].map((k) => `--${k}`).join(", ")}. ` +
        `It takes: ${a.params.map((p) => `--${p.name}${p.required ? " (required)" : ""}`).join(", ")}.`,
      1,
    );
  for (const [k, v] of Object.entries(parsed.flags)) body[k] = typed(a.params.find((p) => p.name === k)!, v);
  const missing = a.params.filter((p) => p.required && (body[p.name] === undefined || body[p.name] === ""));
  if (missing.length)
    throw new Fail(
      `${s.id} ${a.key} needs ${missing.map((p) => `--${p.name}`).join(", ")}:\n` +
        missing.map((p) => `  --${p.name}  ${p.about}`).join("\n"),
      1,
    );
  const res = await fetch(`${API}/api/skills/${encodeURIComponent(s.id)}/${encodeURIComponent(a.key)}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...AUTH },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return passThrough(res, parsed.raw);
}

/* ------------------------------------------------------------------- main */

async function main(argv: string[]): Promise<number> {
  const parsed = parse(argv);
  const [first, second] = parsed.words;

  if (parsed.help && !first) {
    console.log(USAGE);
    return 0;
  }
  if (first === "present") {
    console.log(PRESENT_GUIDE);
    return 0;
  }

  const cat = await catalog();

  if (!first || first === "skills" || first === "list") {
    console.log(listing(cat));
    return 0;
  }

  if (first === "help") {
    if (!second) {
      console.log(USAGE);
      console.log("");
      console.log(listing(cat));
      return 0;
    }
    const s = cat.skills.find((x) => x.id === second);
    if (s) {
      console.log(helpFor(s, cat.rules));
      return 0;
    }
    const d = cat.disconnected.find((x) => x.id === second);
    if (d)
      throw new Fail(
        `${d.id} (${d.title}) is not connected: it needs ${d.needs.join(" or ")}. There is no figure to read, and that is the answer to give.`,
        2,
      );
    throw new Fail(`No skill called "${second}". These exist:\n${listing(cat)}`, 1);
  }

  const s = cat.skills.find((x) => x.id === first);
  if (!s) {
    const d = cat.disconnected.find((x) => x.id === first);
    if (d)
      throw new Fail(
        `${d.id} (${d.title}) is not connected: it needs ${d.needs.join(" or ")}. Report that, never a zero.`,
        2,
      );
    throw new Fail(`No skill called "${first}".\n\n${listing(cat)}`, 1);
  }
  if (parsed.help) {
    console.log(helpFor(s, cat.rules));
    return 0;
  }

  /* The word after the id: a view, an action, or a mistake — never a guess. */
  if (parsed.words.length > 2)
    throw new Fail(`Too many words: "${parsed.words.slice(1).join(" ")}". It is opc ${s.id} [view|action] --flag value.`, 1);
  if (!second) return read(s, s.views[0]!, parsed.flags, parsed.raw);
  const view = s.views.find((v) => v.key === second);
  if (view) return read(s, view, parsed.flags, parsed.raw);
  const action = s.actions.find((a) => a.key === second);
  if (action) return act(s, action, parsed);
  const views = s.views.filter((v) => v.key !== s.views[0]?.key).map((v) => v.key);
  throw new Fail(
    `${s.id} has no view or action called "${second}". ` +
      (views.length ? `Views: ${views.join(", ")}. ` : "It has one view, the default. ") +
      (s.actions.length ? `Actions: ${s.actions.map((a) => a.key).join(", ")}.` : "It has no actions."),
    1,
  );
}

/*
  `exitCode`, NEVER `process.exit()`. On macOS a write to a piped stdout is
  asynchronous, and `process.exit` right after it drops whatever has not left
  the buffer yet — which is everything past 64 KB. That was a 135 KB ventures
  document ending mid-string at exactly 65,536 bytes, and an agent reading it
  concluding that the venture at the end of the list did not exist. Setting
  the code and returning lets the loop drain and then end on its own; nothing
  here holds it open.
*/
main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = err instanceof Fail ? err.code : 2;
  },
);
