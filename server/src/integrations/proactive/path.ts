/**
 * A DOT PATH INTO A DOCUMENT NOBODY HAS SEEN YET.
 *
 * This is the one piece of this area that has to be generic in the strong
 * sense: a rule names a figure inside a JSON document produced by a route that
 * may not have been written when this file was. So the addressing is the
 * simplest thing that can name a number in an arbitrary document — keys
 * separated by dots, `[0]` for an array index, and `@count(...)` for the
 * length of a list.
 *
 * IT IS THE SAME SYNTAX THE PRODUCT ENDPOINTS' METRIC MAPPING USES, and that
 * is deliberate rather than convergent evolution. `integrations/ops/products.ts`
 * asks the owner to type "renders today = stats.today.renders" into a settings
 * field; asking them to learn a second path language for alert rules would be
 * two dialects of the same idea in one product. The implementation is separate
 * — this area does not import that one, because a cross-area import is a
 * coupling the seam exists to prevent — and the two are kept honest by having
 * the same tests written against the same examples.
 *
 * EVERY FAILURE IS ITS OWN SENTENCE AND NONE OF THEM IS A ZERO. A path that
 * resolves to nothing is a rule that cannot be evaluated, which the engine
 * records as an "unreadable" event; it is never a reading of 0, because
 * `{"failed": 0}` and a document with no `failed` field are different facts
 * about the business and only one of them is good news.
 */

export type Resolved = { ok: true; value: number } | { ok: false; why: string };

/** `@count(a.b)` → the length of the list at a.b; anything else → the number
 *  at that path. */
export function parsePath(raw: string): { path: string; count: boolean } {
  const m = /^@count\((.+)\)$/i.exec(raw.trim());
  return m ? { path: m[1]!.trim(), count: true } : { path: raw.trim(), count: false };
}

/** What is wrong with a path, said where it was typed. Null when nothing is. */
export function checkPath(raw: string): string | null {
  const t = raw.trim();
  if (!t) return "A rule needs a path into the document — for example charges[0].failed.";
  const { path } = parsePath(t);
  if (!path) return "@count() needs a path inside it, for example @count(domains).";
  if (!/^[A-Za-z0-9_$]+(\[[0-9]+\])*(\.[A-Za-z0-9_$-]+(\[[0-9]+\])*)*$/.test(path))
    return `“${path}” is not a JSON path. Dots between keys, [0] for an array index — for example charges[0].failed, or @count(domains).`;
  return null;
}

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
     counts that way — and a string that is not a number is still a failure with
     its own sentence. */
  if (typeof node === "string" && node.trim() !== "" && Number.isFinite(Number(node)))
    return { ok: true, value: Number(node) };
  /* A boolean is 1 or 0, which is what makes "is it up" writable as a rule:
     `hosts[0].current.ok == 0`. It is the only place in this area where a zero
     is a reading rather than an absence, and it is one because `false` really
     was measured. */
  if (typeof node === "boolean") return { ok: true, value: node ? 1 : 0 };
  return {
    ok: false,
    why:
      `${path} is ${node === null ? "null" : Array.isArray(node) ? "an array" : typeof node}, not a number.` +
      (Array.isArray(node) ? ` Did you mean @count(${path})?` : ""),
  };
}

/* ------------------------------------------------------------- the flatten */

/**
 * EVERY NUMBER IN A DOCUMENT, WITH THE PATH THAT NAMES IT.
 *
 * This is how the narrator finds "what else changed" without knowing anything
 * about any integration. It walks a document and reports each numeric leaf as
 * `path → value`, so two snapshots of the same skill can be diffed by matching
 * paths — and a skill this file has never heard of diffs exactly as well as a
 * skill it has.
 *
 * IT IS BOUNDED IN THREE DIRECTIONS, because a Stripe document has thousands
 * of numbers in it and the point is a handful of headlines. Depth, because a
 * figure eight levels down inside the fourth element of a series is detail
 * rather than a headline. Array index, because element 900 of a daily series
 * is a day nobody is asking about. And a hard cap on the count, because the
 * output of this feeds a prompt.
 *
 * ARRAYS ARE WALKED ONLY AT THE FIRST FEW INDICES, and that is a real
 * limitation rather than a hidden one: `charges[0].failed` is found and
 * `charges[7].failed` is not. Documents on this box put the thing you want
 * first — the default currency, the newest day, the top site — because that is
 * what their own routes' rules say they do.
 */
export function flattenNumbers(
  doc: unknown,
  opts: { maxDepth?: number; maxArray?: number; cap?: number } = {},
): Map<string, number> {
  const maxDepth = opts.maxDepth ?? 4;
  const maxArray = opts.maxArray ?? 3;
  const cap = opts.cap ?? 400;
  const out = new Map<string, number>();

  const walk = (node: unknown, prefix: string, depth: number) => {
    if (out.size >= cap || depth > maxDepth) return;
    if (typeof node === "number" && Number.isFinite(node)) {
      if (prefix) out.set(prefix, node);
      return;
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < Math.min(node.length, maxArray); i++)
        walk(node[i], `${prefix}[${i}]`, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (out.size >= cap) return;
        walk(v, prefix ? `${prefix}.${k}` : k, depth + 1);
      }
    }
  };

  walk(doc, "", 0);
  return out;
}

export type Movement = {
  path: string;
  before: number;
  after: number;
  /** Null when `before` is 0 — a percentage change from nothing is a division
   *  this box will not do, and the two absolute figures are already here. */
  changePct: number | null;
};

/**
 * WHICH FIGURES MOVED BETWEEN TWO SNAPSHOTS, ranked by how much.
 *
 * Only paths present in BOTH documents are compared. A figure that appeared or
 * disappeared between two reads is a change in the SHAPE of the document — a
 * currency added, a box that stopped answering — and reporting it as a
 * movement from nothing to something would be arithmetic on an absence.
 *
 * Ranked by relative change with an absolute tie-break, then cut to `top`. The
 * ranking is a heuristic about what is interesting and nothing more; every
 * figure it hands on is a real reading from a real document, which is the only
 * property the narrator depends on.
 */
export function movements(
  before: Map<string, number>,
  after: Map<string, number>,
  top = 8,
): Movement[] {
  const out: Movement[] = [];
  for (const [path, now] of after) {
    const was = before.get(path);
    if (was === undefined || was === now) continue;
    out.push({
      path,
      before: was,
      after: now,
      changePct: was === 0 ? null : Math.round(((now - was) / Math.abs(was)) * 1000) / 10,
    });
  }
  out.sort((a, b) => {
    const ra = a.changePct === null ? Infinity : Math.abs(a.changePct);
    const rb = b.changePct === null ? Infinity : Math.abs(b.changePct);
    if (ra !== rb) return rb - ra;
    return Math.abs(b.after - b.before) - Math.abs(a.after - a.before);
  });
  return out.slice(0, top);
}
