/**
 * A RESPONSE BUDGET FOR TOOL RESULTS — summary first, rows second, and never a
 * document cut through the middle.
 *
 * WHAT WENT WRONG WITHOUT IT. Every skill answer was forwarded whole: the MCP
 * layer handed the model whatever the route said, and `opc` printed it. Most
 * documents are two kilobytes and that was fine. A few are not — a board with
 * every card on it, a mailbox page, a run ledger — and a hundred-kilobyte tool
 * result does one of two things to an agent. On a large window it eats the
 * context the ANSWER needed; on a small one the terminal tool truncates it at
 * a byte boundary, which is a JSON document ending mid-string, which the model
 * reads as far as it parses and then reports the rest as not existing. That is
 * the failure mode this file exists to make impossible: the last venture in a
 * list reported as "no such venture" because the list was cut where nobody
 * could see it.
 *
 * THE RULE IS: SCALARS SURVIVE, ARRAYS SHRINK, AND THE CUT IS ANNOUNCED IN
 * BAND. A document that is over budget keeps every scalar and every summary
 * field it has — the totals, the windows, the units, the `null`s that mean "not
 * measured" — because those are the sentences an honest answer is built from
 * and they are cheap. What costs bytes is rows, so rows are what is dropped,
 * longest list first, and each shortened array carries a marker object as its
 * last element:
 *
 *     { "truncated": true, "shown": 20, "total": 412, "next": "…how to page…" }
 *
 * A model reading that knows three things it could not know from a truncated
 * string: that there is more, how much more, and the exact call that fetches
 * it. `shown` and `total` are counted, never estimated.
 *
 * THE OUTPUT IS ALWAYS VALID JSON when the input was. Nothing here slices a
 * serialised document; it edits the parsed value and re-serialises. A string
 * that is itself too long to fit is shortened as a STRING VALUE with an
 * ellipsis inside the quotes, which is still parseable and still obviously
 * abridged — as opposed to a byte cut, which is neither.
 *
 * A BODY THAT IS NOT JSON is truncated as text, on a character boundary
 * (never inside a UTF-8 sequence or a surrogate pair) with a line saying how
 * much was dropped. There is nothing better to do with prose, and the honest
 * report of "you are reading the first 24 KB of 300 KB" is worth more than the
 * silence the terminal tool would otherwise give.
 *
 * PURE, AND THAT IS WHY IT IS ITS OWN FILE. It imports nothing, reads no
 * settings and touches no database, so both processes that need it — the MCP
 * server and the `opc` CLI, neither of which has a database handle — can use
 * the same implementation, and the edge cases (nested arrays, mixed types, a
 * document exactly on the limit) are covered by unit tests rather than by
 * running an agent and hoping.
 */

/**
 * THE DEFAULT CEILING, IN BYTES.
 *
 * 24 KB, and the number is not arbitrary: it is what `opc` already warned
 * about at, measured against Hermes' terminal tool truncating long output — so
 * the budget that SHAPES a document and the threshold that used to complain
 * about one are the same number rather than two numbers that drift apart.
 *
 * It lives in this file, which imports nothing, because the three processes
 * that need it — the server, the MCP child and the CLI — must not all reach
 * for a module with a database handle to learn one integer.
 */
export const DEFAULT_RESPONSE_BYTES = 24 * 1024;

/** UTF-8 is the wire, so the budget is bytes and not characters: a document of
 *  emoji is four times the size a `.length` check would report, and the byte
 *  count is what a context window and a pipe both actually see. */
const ENC = new TextEncoder();

export function byteLength(s: string): number {
  return ENC.encode(s).length;
}

export type BoundOptions = {
  /** The ceiling, in bytes, for the document handed to the agent. */
  budget: number;
  /** Top-level keys to keep, when the caller asked for a subset. Ignored for a
   *  body that is not a JSON object — there are no top-level keys to pick. */
  fields?: string[] | null;
  /** ONE SENTENCE SAYING HOW TO GET THE REST, in the caller's own vocabulary:
   *  the CLI says `--limit`/`--offset`, the MCP layer says the parameter names.
   *  It is written into every truncation marker, so the model reads the way
   *  out at the exact point it discovers there is more. */
  how?: string | null;
  /** Indent the JSON (the CLI prints for a human), or keep it compact (the MCP
   *  layer feeds a model). The budget is measured against whichever is emitted,
   *  because that is what actually costs. */
  pretty?: boolean;
};

export type Trim = {
  /** Where in the document, in dotted/bracketed form: `items[3].rows`. */
  path: string;
  shown: number;
  total: number;
};

export type Bound = {
  /** What to hand on. Valid JSON whenever the input was. */
  text: string;
  bytes: number;
  originalBytes: number;
  /** True when anything at all was removed — a field filter, a shortened array,
   *  an abridged string, a text cut. */
  bounded: boolean;
  /** Whether the body parsed as JSON. False means it was treated as prose. */
  json: boolean;
  /** One line for the agent, or null when nothing was removed. */
  note: string | null;
  /** Every array that lost rows, longest first. */
  trimmed: Trim[];
  /** Field names asked for that the document does not have — a silent empty
   *  result would read as "the field is empty" rather than "you misspelt it". */
  unknownFields: string[];
};

/* --------------------------------------------------------------- utilities */

/**
 * The first `max` BYTES of a string, ending on a character.
 *
 * Binary search over code-unit indices, then one step back off a lone high
 * surrogate. Cutting mid-sequence produces a replacement character in the
 * middle of a word, which is the exact class of silent corruption this file
 * exists to prevent — and it is worse here than in a stream, because nothing
 * downstream will ever repair it.
 */
export function sliceBytes(s: string, max: number): string {
  if (max <= 0) return "";
  if (byteLength(s) <= max) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (byteLength(s.slice(0, mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  /* A high surrogate with its pair left behind is half a character. */
  const code = s.charCodeAt(lo - 1);
  if (lo > 0 && code >= 0xd800 && code <= 0xdbff) lo -= 1;
  return s.slice(0, lo);
}

function serialise(value: unknown, pretty: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/** The marker appended to an array that lost rows. Its shape is the contract
 *  the skills preamble documents, so it is built in exactly one place. */
type Marker = { truncated: true; shown: number; total: number; next: string };

type Candidate = {
  arr: unknown[];
  path: string;
  total: number;
  marker: Marker | null;
};

/** Every array in the document, with the path a reader could follow to it. */
function arrays(value: unknown, path: string, out: Candidate[]): void {
  if (Array.isArray(value)) {
    out.push({ arr: value, path: path || "$", total: value.length, marker: null });
    for (let i = 0; i < value.length; i++) arrays(value[i], `${path}[${i}]`, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      arrays(v, path ? `${path}.${k}` : k, out);
  }
}

/** Every string in the document that is long enough to be worth abridging,
 *  with the setter that replaces it. Only reached when there are no rows left
 *  to drop — a document that is all prose in one field. */
type StringSlot = { get: () => string; set: (v: string) => void };

function strings(value: unknown, out: StringSlot[]): void {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      if (typeof v === "string") out.push({ get: () => value[i] as string, set: (s) => (value[i] = s) });
      else strings(v, out);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string") out.push({ get: () => obj[k] as string, set: (s) => (obj[k] = s) });
      else strings(v, out);
    }
  }
}

/* ------------------------------------------------------------------ the cut */

const KB = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;

/**
 * Fit a response body inside a byte budget.
 *
 * The order is deliberate and each step is cheaper than the next in
 * information lost: pick the fields the caller asked for, then shorten the
 * longest arrays, then abridge the longest strings, then — only if a single
 * scalar is somehow bigger than the whole budget — replace the document with a
 * note saying so. A document already inside the budget is returned byte for
 * byte, including its original formatting, because re-serialising a fine
 * answer would be this function changing something for nothing.
 */
export function boundResponse(body: string, opts: BoundOptions): Bound {
  /* A floor rather than a validation: a budget of zero would be a caller
     asking for nothing, and answering an empty string is worse than answering
     a sentence saying the document did not fit. The SETTING has a much higher
     minimum (see the manifest); this is only a guard against nonsense. */
  const budget = Math.max(64, Math.floor(opts.budget));
  const pretty = opts.pretty === true;
  const how = (opts.how ?? "").trim() || "narrow the call and ask again";
  const originalBytes = byteLength(body);
  const wanted = (opts.fields ?? []).map((f) => f.trim()).filter(Boolean);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    /* NOT JSON. Prose, HTML, a stack trace — cut on a character and say so. */
    if (originalBytes <= budget)
      return {
        text: body,
        bytes: originalBytes,
        originalBytes,
        bounded: false,
        json: false,
        note: null,
        trimmed: [],
        unknownFields: [],
      };
    const footer = `\n… [cut here: ${KB(budget)} of ${KB(originalBytes)} shown — ${how}]`;
    const kept = sliceBytes(body, budget - byteLength(footer));
    const text = kept + footer;
    return {
      text,
      bytes: byteLength(text),
      originalBytes,
      bounded: true,
      json: false,
      note:
        `This is the first ${KB(budget)} of a ${KB(originalBytes)} document and it is ` +
        `not JSON, so it was cut as text — ${how}.`,
      trimmed: [],
      unknownFields: [],
    };
  }

  /* ------------------------------------------------------------ the fields */

  const unknownFields: string[] = [];
  let root = parsed;
  let picked = false;
  if (wanted.length) {
    if (typeof root === "object" && root !== null && !Array.isArray(root)) {
      const src = root as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const f of wanted) {
        if (f in src) out[f] = src[f];
        else unknownFields.push(f);
      }
      /* An `error` key is never filtered away: a caller that asked for `rows`
         and got a refusal must still be able to read the refusal. */
      if ("error" in src && !("error" in out)) out.error = src.error;
      root = out;
      picked = true;
    } else {
      /* Nothing to pick from. Reported rather than silently ignored. */
      unknownFields.push(...wanted);
    }
  }

  /* Cloned before anything is trimmed, so the shortening below edits a copy.
     `root` after a field pick is a fresh object holding the SAME arrays as the
     parsed document, and mutating those would be this function editing its own
     input — harmless today, and the kind of harmless that stops being so the
     first time a caller wants both the whole document and a bounded one. */
  const doc: unknown = structuredClone(root) as unknown;

  let text = serialise(doc, pretty);
  if (byteLength(text) <= budget) {
    const bounded = picked || unknownFields.length > 0;
    return {
      text: picked ? text : body,
      bytes: picked ? byteLength(text) : originalBytes,
      originalBytes,
      bounded,
      json: true,
      note: bounded
        ? `Only the fields you asked for are here` +
          (unknownFields.length
            ? `; this document has no ${unknownFields.map((f) => `\`${f}\``).join(", ")}.`
            : `.`)
        : null,
      trimmed: [],
      unknownFields,
    };
  }

  /* ------------------------------------------------------------- the arrays */

  const candidates: Candidate[] = [];
  arrays(doc, "", candidates);

  /* Guarded rather than trusted to converge: a pathological document (an array
     whose every element is a marker-shaped object) must end the loop rather
     than spin. Each pass removes at least one row from at least one array, so
     the bound is the number of rows. */
  let guard = 200_000;
  for (;;) {
    const size = byteLength(text);
    if (size <= budget) break;
    if (guard-- <= 0) break;

    /* The array that costs the most right now, not the one with the most rows:
       twenty fat objects are worth dropping before four hundred integers. */
    let worst: Candidate | null = null;
    let worstBytes = 0;
    for (const c of candidates) {
      const rows = c.marker ? c.arr.length - 1 : c.arr.length;
      if (rows <= 0) continue;
      const b = byteLength(serialise(c.arr, pretty));
      if (b > worstBytes) {
        worst = c;
        worstBytes = b;
      }
    }
    if (!worst) break;

    const rows = worst.marker ? worst.arr.length - 1 : worst.arr.length;
    /* Drop in proportion to how far over we are, so a document ten times the
       budget converges in a handful of passes rather than in a thousand. At
       least one row always goes, or this is not progress. */
    const over = 1 - budget / size;
    const drop = Math.min(rows, Math.max(1, Math.ceil(rows * Math.min(0.9, Math.max(0.05, over)))));
    worst.arr.splice(rows - drop, drop);
    const shown = worst.marker ? worst.arr.length - 1 : worst.arr.length;
    if (worst.marker) {
      worst.marker.shown = shown;
    } else {
      /* The marker is appended the first time an array loses a row, so its own
         size is counted by every pass after this one rather than discovered at
         the end when the budget has already been spent. */
      worst.marker = { truncated: true, shown, total: worst.total, next: how };
      worst.arr.push(worst.marker);
    }
    text = serialise(doc, pretty);
  }

  /* ------------------------------------------------------------ the strings */

  if (byteLength(text) > budget) {
    const slots: StringSlot[] = [];
    strings(doc, slots);
    let passes = 40;
    while (byteLength(text) > budget && passes-- > 0) {
      let longest: StringSlot | null = null;
      let longestLen = 0;
      for (const s of slots) {
        const len = s.get().length;
        if (len > longestLen) {
          longest = s;
          longestLen = len;
        }
      }
      if (!longest || longestLen <= 24) break;
      const cur = longest.get();
      const keep = Math.max(12, Math.floor(cur.length / 2));
      longest.set(`${sliceBytes(cur, byteLength(cur.slice(0, keep)))}… [abridged]`);
      text = serialise(doc, pretty);
    }
  }

  /* --------------------------------------------------------- the last resort */

  if (byteLength(text) > budget) {
    /*
      A single value larger than the whole budget and nothing left to shorten.
      Answering with a cut document would be answering with something that does
      not parse, so the answer is an honest refusal that names the size and the
      way out. This is reachable only by a document that is one enormous scalar.
    */
    const bail = {
      truncated: true,
      error:
        `This response is ${KB(originalBytes)} and could not be shortened to the ` +
        `${KB(budget)} tool budget without cutting a value in half.`,
      next: how,
      originalBytes,
    };
    const out = serialise(bail, pretty);
    return {
      text: out,
      bytes: byteLength(out),
      originalBytes,
      bounded: true,
      json: true,
      note: bail.error,
      trimmed: [],
      unknownFields,
    };
  }

  const trimmed: Trim[] = candidates
    .filter((c) => c.marker !== null)
    .map((c) => ({ path: c.path, shown: c.marker!.shown, total: c.marker!.total }))
    .sort((a, b) => b.total - a.total);

  const parts: string[] = [];
  if (picked) parts.push(`only the fields you asked for are here`);
  if (trimmed.length)
    parts.push(
      `${trimmed.length === 1 ? "one list was" : `${trimmed.length} lists were`} shortened to fit ` +
        `the ${KB(budget)} tool budget (the whole document is ${KB(originalBytes)}): ` +
        trimmed
          .slice(0, 4)
          .map((t) => `${t.path} shows ${t.shown} of ${t.total}`)
          .join(", "),
    );
  if (unknownFields.length)
    parts.push(`this document has no ${unknownFields.map((f) => `\`${f}\``).join(", ")}`);

  return {
    text,
    bytes: byteLength(text),
    originalBytes,
    bounded: true,
    json: true,
    note: parts.length
      ? `${parts.join("; ")}. Every shortened list ends with a {"truncated":true} marker ` +
        `saying how many rows exist — ${how}.`
      : null,
    trimmed,
    unknownFields,
  };
}

/**
 * The three optional parameters every proxied read understands, said in the
 * fewest words that still say what they do.
 *
 * Written here rather than in the two callers because a preamble and a CLI
 * help page that describe the same three flags differently are two contracts,
 * and the second one a model reads is the one it will get wrong.
 */
export const PAGING_PARAMS = [
  "limit — how many rows (only where the view takes one)",
  "offset — skip this many rows first (only where the view takes one)",
  "fields — comma-separated top-level keys to keep, e.g. fields=totals,window",
];
