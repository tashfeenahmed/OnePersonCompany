/**
 * THE MAPPING FILE, READ.
 *
 * These adapters run on the PRODUCT's host — a box that has the product's
 * database on it and nothing of this dashboard — so they may not have
 * dependencies. Not "should not": a template whose first instruction is
 * `npm install` is a template that does not get installed on the mail server,
 * and the whole point of an adapter is that it goes where the data already is.
 *
 * That decision costs a YAML parser, so this file is one, and it reads a
 * DELIBERATE SUBSET rather than pretending to be YAML:
 *
 *   - two-space indentation, nested maps and lists of scalars or maps
 *   - `key: value` scalars: bare strings, quoted strings, numbers, true/false,
 *     null/~, `|` block scalars for a multi-line SQL query, and a single-line
 *     flow list of plain values — [1, "t", yes]
 *   - `# ` comments to end of line, outside quotes
 *
 * and nothing else. No anchors, no flow mappings, no multi-document files, no
 * tags. Anything it cannot read is an ERROR NAMING THE LINE, never a silent
 * omission — a mapping file half-read is a users document with a field missing,
 * which is exactly the failure this whole contract exists to make loud. That
 * promise is why a repeated key throws rather than taking the last one, why a
 * flow list splits on commas OUTSIDE quotes rather than all of them, and why
 * `__proto__` is refused instead of quietly rewriting the object it is read
 * into.
 *
 * A `.json` file skips all of it and is parsed by JSON.parse. If the subset
 * annoys you, write JSON.
 */
import { readFileSync } from "node:fs";

/** Everything after an unquoted `#`, removed. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(raw, where) {
  const t = raw.trim();
  if (t === "") return "";
  if (t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"') && t.length > 1) ||
      (t.startsWith("'") && t.endsWith("'") && t.length > 1)) {
    const body = t.slice(1, -1);
    return t[0] === '"' ? body.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c === "t" ? "\t" : c)) : body;
  }
  /* ONE PIECE OF FLOW SYNTAX IS SUPPORTED: a bracketed list of SCALARS, because
     `true_values: [1, "t", yes]` is how everybody writes a three-item list and
     forcing it onto four lines would be a subset nobody could type from memory.
     Nested brackets and flow MAPPINGS are still refused — those are where a
     hand-rolled parser starts being wrong quietly. */
  if (t.startsWith("[")) {
    if (!t.endsWith("]") || t.slice(1, -1).includes("[") || t.includes("{"))
      throw new Error(`${where}: “${t}” is a flow list this cannot read. Only a single-line list of plain values — [1, "t", yes] — is supported; anything nested goes on indented lines or into a .json file.`);
    const body = t.slice(1, -1).trim();
    if (!body) return [];
    /* SPLIT ON COMMAS THAT ARE NOT INSIDE QUOTES. A naive split turns
       `["a,b", 1]` into `'"a'`, `'b"'`, `1` — three items, two of them
       nonsense, silently. That matters most on `true_values`, which is the
       CONSENT list: an item that quietly became `"a` matches nothing, and a
       consent column that matches nothing is a column read as "nobody agreed",
       which is at least the safe direction and is still a lie about the data.
       An unterminated quote is an error naming the line, never a best guess. */
    const parts = [];
    let current = "";
    let quote = null;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (quote) {
        current += c;
        if (c === "\\" && quote === '"') { current += body[++i] ?? ""; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; current += c; continue; }
      if (c === ",") { parts.push(current); current = ""; continue; }
      current += c;
    }
    if (quote) throw new Error(`${where}: “${t}” has an unclosed ${quote === '"' ? "double" : "single"} quote in it.`);
    parts.push(current);
    return parts.map((part) => scalar(part, where));
  }
  if (t.startsWith("{"))
    throw new Error(`${where}: flow mappings ({…}) are not supported. Use indented lines, or write the file as JSON.`);
  if (t.includes(": "))
    throw new Error(`${where}: “${t}” looks like a nested mapping on one line. Put it on its own indented lines, or quote it.`);
  return t;
}

/**
 * The parser. Recursive over an indentation-sorted line list, so a structural
 * mistake is caught where it is rather than three levels later.
 */
function parseBlock(lines, i, indent) {
  // A list at this indent?
  if (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
    const out = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("- ")) {
      const rest = lines[i].text.slice(2).trim();
      const at = `line ${lines[i].n}`;
      if (rest === "") {
        const [value, next] = parseBlock(lines, i + 1, indent + 2);
        out.push(value);
        i = next;
      } else if (/^[A-Za-z0-9_.-]+:( |$)/.test(rest)) {
        /* `- key: value` — an inline first key of a map item. Re-fed to the map
           parser as if it had been on its own line at indent + 2. */
        const inner = [{ n: lines[i].n, indent: indent + 2, text: rest }];
        let j = i + 1;
        while (j < lines.length && lines[j].indent >= indent + 2) { inner.push(lines[j]); j++; }
        const [value] = parseBlock(inner, 0, indent + 2);
        out.push(value);
        i = j;
      } else {
        out.push(scalar(rest, at));
        i += 1;
      }
    }
    return [out, i];
  }

  /* A NULL-PROTOTYPE OBJECT, because a mapping file is untrusted input the
     moment it is a file at all. `{}` inherits Object.prototype, so a line
     reading `__proto__:` with a nested map under it does not add a key — it
     REPLACES the prototype, and `config.driver` then answers with a value that
     appears nowhere in the file. `Object.create(null)` makes that assignment an
     ordinary own property; the two names are refused below as well, because a
     mapping with a key called `constructor` is a mistake either way. */
  const out = Object.create(null);
  const seen = new Set();
  while (i < lines.length && lines[i].indent === indent) {
    const { n, text } = lines[i];
    const at = `line ${n}`;
    const colon = text.indexOf(":");
    if (colon < 1) throw new Error(`${at}: “${text}” is not “key: value”.`);
    const key = text.slice(0, colon).trim();
    const rest = text.slice(colon + 1).trim();

    if (key === "__proto__" || key === "constructor" || key === "prototype")
      throw new Error(`${at}: “${key}” is not a key this will read. It names part of the object machinery rather than part of your mapping.`);
    /* A REPEATED KEY IS AN ERROR AND NOT LAST-WINS. Two `population:` blocks in
       one file is somebody editing the second copy and reading the first, and
       silently keeping one of them is how a mapping is wrong for a month. */
    if (seen.has(key))
      throw new Error(`${at}: “${key}” is set twice at this level. One of the two is being ignored; delete it rather than leave both.`);
    seen.add(key);

    if (rest === "|" || rest === "|-") {
      /* A block scalar: every following line indented past this key, verbatim,
         with the common indent removed. This is how a SQL query gets in. */
      const body = [];
      let j = i + 1;
      const base = lines[j]?.indent ?? indent + 2;
      while (j < lines.length && (lines[j].indent > indent || lines[j].text === "")) {
        body.push(" ".repeat(Math.max(0, lines[j].indent - base)) + lines[j].text);
        j++;
      }
      out[key] = rest === "|-" ? body.join("\n").replace(/\n+$/, "") : `${body.join("\n")}\n`;
      i = j;
      continue;
    }

    if (rest === "") {
      const childIndent = lines[i + 1]?.indent ?? -1;
      if (childIndent > indent) {
        const [value, next] = parseBlock(lines, i + 1, childIndent);
        out[key] = value;
        i = next;
      } else {
        out[key] = null;
        i += 1;
      }
      continue;
    }

    out[key] = scalar(rest, at);
    i += 1;
  }
  return [out, i];
}

/** One mapping file, as an object. Throws with a line number. */
export function loadConfig(path) {
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".json")) {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`${path} is not valid JSON: ${err.message}`);
    }
  }

  const lines = [];
  text.split("\n").forEach((raw, idx) => {
    const stripped = stripComment(raw.replace(/\r$/, ""));
    if (!stripped.trim()) return;
    if (/^\t/.test(stripped))
      throw new Error(`${path} line ${idx + 1}: tabs are not indentation here. Use two spaces.`);
    lines.push({ n: idx + 1, indent: stripped.length - stripped.trimStart().length, text: stripped.trim() });
  });
  if (!lines.length) return {};

  const [doc, consumed] = parseBlock(lines, 0, lines[0].indent);
  if (consumed !== lines.length)
    throw new Error(
      `${path} line ${lines[consumed].n}: this line is indented ${lines[consumed].indent} where ${lines[0].indent} was expected. ` +
        `The subset this reads is two-space nesting with no flow syntax — see lib/config.mjs.`,
    );
  return doc;
}

/**
 * `${ENV_VAR}` anywhere in a string, replaced from the environment.
 *
 * THE ONLY WAY A SECRET GETS INTO ONE OF THESE FILES. A connection string with
 * a password in it lives in an environment file with mode 600, not in the
 * mapping that gets committed; an unset variable is a REFUSAL naming it,
 * because an adapter that connected to `postgres://user:@host` because the
 * password expanded to nothing would produce an authentication error somebody
 * spends an hour on.
 */
export function expandEnv(value, env = process.env) {
  if (typeof value !== "string") return value;
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (env[name] === undefined || env[name] === "")
      throw new Error(`\${${name}} is used in the mapping and ${name} is not set in the environment.`);
    return env[name];
  });
}
