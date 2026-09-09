/**
 * THE SIDEBAR'S ONE LIST, IN THE OWNER'S ORDER.
 *
 * The rail used to be five headed groups — Manage, Insights, Work, Mail,
 * Social media — each folding on its own. That is a taxonomy nobody asked
 * for: the owner knows what Triage is without a heading saying Mail above
 * it, and the fold state of five groups is five things to keep straight. It
 * is one list now, the first few rows always showing and the rest behind
 * "See more", and the ORDER is the owner's: a row dragged to the top stays
 * at the top.
 *
 * `navOrder` is that order, by path, and it is optional and partial. Absent
 * on an older state; the build's own order is the default. A path in it that
 * no longer exists is dropped at read time rather than migrated away, and a
 * page a later build adds that the owner has never placed lands AFTER the
 * ones they have, in the build's order — behind the fold, which is where a
 * page nobody has reached for belongs, rather than displacing a row they put
 * where it is.
 */
export function orderNav(defaults: readonly string[], navOrder?: readonly string[]): string[] {
  const known = new Set(defaults);
  const chosen: string[] = [];
  for (const path of navOrder ?? []) {
    if (known.has(path) && !chosen.includes(path)) chosen.push(path);
  }
  const placed = new Set(chosen);
  return [...chosen, ...defaults.filter(path => !placed.has(path))];
}
