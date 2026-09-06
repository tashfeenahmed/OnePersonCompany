/**
 * WHAT ELSE MOVED — the flatten and the diff behind the narration.
 *
 * THE ADDRESS ITSELF NOW LIVES IN `shared/metrics-address.ts`. A dot path into
 * a document, `@count(...)`, the parameter reader, the URL builder and the
 * loopback read were written twice on this box, by this area and by the
 * outcomes tracker, and the two had already disagreed about `@count`. What is
 * left here is the half that is genuinely this area's: taking a whole document
 * apart into every number in it, and diffing two of those.
 *
 * IT IS THE OTHER DIRECTION FROM AN ADDRESS. A rule NAMES a figure; the
 * narrator does not know what to name, so it walks everything and reports what
 * changed. That is why a skill this file has never heard of diffs exactly as
 * well as one it has.
 */

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
