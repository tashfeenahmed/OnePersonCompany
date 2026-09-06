/**
 * THE ADDRESS OF A FIGURE, READ ON A SCHEDULE.
 *
 * Two areas independently invented the same four-column address. An alert rule
 * names a skill, a view, some parameters and a path into the document; an
 * outcome — "did the thing I did actually move anything?" — names exactly the
 * same four. Both then fetch `GET /api/skills/<id>` over loopback with the
 * service key, parse the JSON, and walk a dotted path to a number.
 *
 * WHY AN ADDRESS AND NOT A FUNCTION. `skill` + `view` + `params` + `path` is
 * how everything on this box addresses a figure: the skills proxy turns the
 * first three into a document and the path picks a field out of it. That is
 * what makes both features generic — a metric another area ships next month is
 * watchable and trackable the day it ships, with no edit here — and it is also
 * what makes them honest, because the document a reading came out of is
 * nameable in the answer, and it is the same document the owner would get from
 * curl.
 *
 * THE TWO COPIES HAD ALREADY DISAGREED, WHICH IS WHY THIS FILE EXISTS:
 *
 *   - One resolver supported `@count(...)` and the other did not. A path
 *     copied from a working alert rule read as "nothing at that path" in an
 *     outcome — a null reading with a plausible-sounding reason, which is the
 *     worst kind of wrong answer because it looks like a finding.
 *   - The two `readParams` differed on what a parameter may be, so one stored
 *     address could produce two different query strings.
 *   - The two URL builders differed on the view. One sent `?view=default`
 *     whenever the column held that word; the other omitted it. `default` is
 *     the SENTINEL both features store for "the entry's own first view", and
 *     the skills route resolves an absent view to exactly that — while a
 *     literal `?view=default` 404s on any skill whose first view is called
 *     something else. So omitting it is not a preference, it is the correct
 *     one, and it is what this does.
 *
 * SUPERSET RATHER THAN INTERSECTION, everywhere the two differed: `@count`,
 * booleans as 1 and 0, numeric strings, and the fuller failure sentences.
 * Nothing that worked in either area stops working.
 *
 * A FIGURE THAT CANNOT BE READ IS NULL AND NEVER ZERO. This is the rule the
 * whole idea turns on. A disconnected plugin, a renamed field, a route that
 * 500s: each records a null with its own sentence. A zero would put a cliff in
 * a chart that the owner would read as a collapse in the business, and
 * `{"failed": 0}` and a document with no `failed` field are different facts
 * about the world with only one of them good news.
 */
import { PORT } from "../config.ts";
import { serviceHeaders } from "../auth.ts";

/* ------------------------------------------------------------- the address */

export type Address = {
  /** The skill id, as `GET /api/skills/<id>` takes it. */
  skill: string;
  /** The view within it. Empty or the literal "default" means the entry's own
   *  first view, which is what an absent `view` parameter resolves to. */
  view?: string | null;
  /** The parameters, as a JSON object or as the JSON text a column holds. */
  params?: string | Record<string, unknown> | null;
  /** The dotted path to the figure inside the answer. */
  path: string;
};

/* ---------------------------------------------------------------- the path */

export type Resolved = { ok: true; value: number } | { ok: false; why: string };

/**
 * `@count(a.b)` → the length of the list at a.b; anything else → the number at
 * that path.
 *
 * THE SAME SYNTAX THE PRODUCT ENDPOINTS' METRIC MAPPING USES, deliberately.
 * That surface asks an owner to type "renders today = stats.today.renders" into
 * a settings field; asking them to learn a second path language for an alert
 * rule and a third for an outcome would be three dialects of one idea in one
 * product.
 */
export function parsePath(raw: string): { path: string; count: boolean } {
  const m = /^@count\((.+)\)$/i.exec(raw.trim());
  return m ? { path: m[1]!.trim(), count: true } : { path: raw.trim(), count: false };
}

/** What is wrong with a path, said where it was typed. Null when nothing is. */
export function checkPath(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "This needs a path into the document — for example charges[0].failed.";
  const { path } = parsePath(t);
  if (!path) return "@count() needs a path inside it, for example @count(domains).";
  if (!/^[A-Za-z0-9_$]+(\[[0-9]+\])*(\.[A-Za-z0-9_$-]+(\[[0-9]+\])*)*$/.test(path))
    return `“${path}” is not a JSON path. Dots between keys, [0] for an array index — for example charges[0].failed, or @count(domains).`;
  return null;
}

/**
 * Walk a dotted path into a document and come back with a number, or with a
 * sentence saying why there is not one.
 *
 * DELIBERATELY NOT JSONPath. The expression language is the part that would
 * let a caller write a filter whose answer changes SHAPE between two readings,
 * and a metric whose shape can change is not a metric.
 *
 * EVERY FAILURE IS ITS OWN SENTENCE. "The figure is null" is three completely
 * different findings — nobody connected the plugin, the address is wrong, the
 * number is genuinely not reported — and a chart with a gap in it should be
 * able to say which.
 */
export function resolvePath(doc: unknown, raw: string): Resolved {
  const { path, count } = parsePath(raw);
  const parts = [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) =>
    m[2] !== undefined ? Number(m[2]) : m[1]!,
  );
  if (!parts.length) return { ok: false, why: `“${raw}” names nothing.` };

  let node: unknown = doc;
  const walked: string[] = [];
  for (const part of parts) {
    const here = walked.join(".") || "the document";
    if (node === null || node === undefined)
      return { ok: false, why: `${here} is null, so ${path} goes nowhere.` };
    if (typeof part === "number") {
      if (!Array.isArray(node))
        return { ok: false, why: `${here} is not an array, so [${part}] means nothing here.` };
      if (part >= node.length)
        return { ok: false, why: `${here} has ${node.length} item(s), so [${part}] is past the end.` };
      node = node[part];
      walked.push(`[${part}]`);
      continue;
    }
    if (typeof node !== "object" || Array.isArray(node))
      return { ok: false, why: `${here} is not an object, so “${part}” cannot be read from it.` };
    if (!(part in (node as Record<string, unknown>)))
      return {
        ok: false,
        why: `${here} has no “${part}”. It has: ${
          Object.keys(node as Record<string, unknown>).slice(0, 8).join(", ") || "nothing"
        }.`,
      };
    node = (node as Record<string, unknown>)[part];
    walked.push(part);
  }

  if (count) {
    if (!Array.isArray(node))
      return { ok: false, why: `${path} is not an array, so @count() has nothing to count.` };
    return { ok: true, value: node.length };
  }

  if (typeof node === "number" && Number.isFinite(node)) return { ok: true, value: node };
  /* A number that arrived as a string is accepted — plenty of documents publish
     counts that way, and several here publish them formatted — and a string
     that is not a number is still a failure with its own sentence. */
  if (typeof node === "string" && node.trim() !== "") {
    const n = Number(node.replace(/[,\s]/g, ""));
    if (Number.isFinite(n)) return { ok: true, value: n };
  }
  /* A boolean is 1 or 0, which is what makes "is it up" writable as a rule:
     `hosts[0].current.ok == 0`. It is the only place here where a zero is a
     reading rather than an absence, and it is one because `false` really was
     measured. */
  if (typeof node === "boolean") return { ok: true, value: node ? 1 : 0 };
  /* The document's own null, carried through as itself. This is the case the
     universal rules are about: asked and not told. */
  if (node === null)
    return {
      ok: false,
      why: `${path} reports null — asked and not told, which is not zero.`,
    };
  return {
    ok: false,
    why:
      `${path} is ${Array.isArray(node) ? "an array" : typeof node}, not a number.` +
      (Array.isArray(node) ? ` Did you mean @count(${path})?` : ""),
  };
}

/* -------------------------------------------------------------- the params */

/**
 * The parameters of an address, as strings, from a column or an object.
 *
 * THE SUPERSET OF THE TWO COPIES. One accepted strings and numbers; the other
 * accepted any scalar, which is the wider rule and the right one — a boolean
 * parameter travels as `true`, which is what the skills proxy would have
 * received had a person typed it. Nested objects are dropped either way: a
 * query string has nowhere to put one, and silently flattening it would be
 * this file inventing an encoding.
 *
 * UNPARSEABLE JSON IS NO PARAMETERS, not an exception. The column is written
 * by this box and read on a schedule; a hand-edited row should cost the
 * reading its parameters and say so through the answer it gets back, rather
 * than take down the pass that was reading a dozen other addresses.
 */
export function paramsOf(raw: string | Record<string, unknown> | null | undefined): Record<string, string> {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return {};
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
    if (v !== null && v !== undefined && typeof v !== "object") out[k] = String(v);
  return out;
}

/* ----------------------------------------------------------------- the URL */

/**
 * Where this box's own skills surface is.
 *
 * Composed from the PORT the server binds rather than imported from
 * `skills/registry.ts`, for that file's own reason: importing a VALUE out of
 * the registry from a module the registry transitively imports is the cycle
 * that crashes the server at boot. The port is the one thing this needs and
 * config.ts owns it.
 */
export const apiBase = (): string => `http://127.0.0.1:${PORT}`;

/**
 * The URL one address reads.
 *
 * PUBLIC SO A ROUTE CAN SHOW IT. An owner who can see the request can check
 * the answer themselves with curl, which is the difference between a figure
 * they trust and a figure they are told.
 *
 * THE VIEW IS OMITTED WHEN IT IS EMPTY OR "default" — see the header. That is
 * the one place the two copies produced different URLs from one stored
 * address, and it is a 404 rather than a preference.
 */
export function urlFor(addr: Address, base = apiBase()): string {
  const q = new URLSearchParams();
  const view = (addr.view ?? "").trim();
  if (view && view !== "default") q.set("view", view);
  for (const [k, v] of Object.entries(paramsOf(addr.params))) q.set(k, v);
  const qs = q.toString();
  return `${base}/api/skills/${encodeURIComponent(addr.skill)}${qs ? `?${qs}` : ""}`;
}

/* ------------------------------------------------------------- the reading */

export type Reading = {
  /** The figure, or null with a reason beside it. Never zero for an absence. */
  value: number | null;
  error: string | null;
  /** What the document actually held at the path, truncated. Kept so a null
   *  reading can be argued with rather than only believed. */
  raw: string | null;
  /** The request that was made, so the answer can be checked by hand. */
  url: string;
  /** The parsed document, when there was one. Held so a caller taking several
   *  readings out of one document does not fetch it twice. */
  doc?: unknown;
};

export type ReadOptions = {
  signal?: AbortSignal;
  /**
   * A per-pass cache keyed by URL. Two addresses reading two paths in one
   * Stripe document are one request.
   *
   * IT LIVES FOR ONE PASS AND IS THROWN AWAY. A document held between cycles
   * is a document that has stopped being the present, and a figure read out of
   * it would be reported with the current timestamp.
   */
  docs?: Map<string, unknown>;
  /** For tests and for a caller that already has the document. */
  base?: string;
};

/**
 * Take one reading.
 *
 * THE SERVICE KEY, for the reason every loopback call on this box carries it:
 * there is no cookie here, and the gate refuses an anonymous caller once a
 * password is set.
 *
 * A NON-NUMBER AT THE PATH IS AN ERROR AND NOT A ZERO, and the error says what
 * it actually found.
 */
export async function takeReading(addr: Address, opts: ReadOptions = {}): Promise<Reading> {
  const url = urlFor(addr, opts.base ?? apiBase());
  const no = (error: string, raw: string | null = null, doc?: unknown): Reading => ({
    value: null,
    error,
    raw,
    url,
    doc,
  });

  if (opts.docs?.has(url)) return fromDoc(addr, opts.docs.get(url), url);

  let res: Response;
  try {
    res = await fetch(url, { headers: serviceHeaders(), signal: opts.signal });
  } catch (err) {
    return no(
      `${addr.skill} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return no(`${addr.skill} answered something that is not JSON.`, text.slice(0, 400));
  }

  if (!res.ok) {
    /* The proxy's own sentence, verbatim. It already distinguishes "there is
       no such skill" from "the credential is missing" from "that view takes no
       such parameter", and every one of those is a better message than
       anything this file could compose out of a status code. */
    const why =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `${addr.skill} answered ${res.status}.`;
    return no(why, text.slice(0, 400));
  }

  opts.docs?.set(url, parsed);
  return fromDoc(addr, parsed, url);
}

/** The path applied to a document already in hand. Split out so a caller with
 *  a cached document — or a test with a literal one — takes the same reading
 *  by the same rules. */
export function fromDoc(addr: Address, doc: unknown, url = ""): Reading {
  const got = resolvePath(doc, addr.path);
  if (!got.ok) return { value: null, error: got.why, raw: null, url, doc };
  return { value: got.value, error: null, raw: String(got.value), url, doc };
}
