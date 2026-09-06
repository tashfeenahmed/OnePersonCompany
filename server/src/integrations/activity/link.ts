/**
 * WHICH BUSINESS A PRODUCT'S USERS BELONG TO.
 *
 * Three answers, tried in that order, because they are worth different
 * amounts and a weaker one must never overwrite a stronger:
 *
 *   1. THE SETTING. A line the owner typed — "APP-1 = acme" — is
 *      somebody stating that these two things are the same business. Nothing
 *      derived may contradict it.
 *   2. THE LINK. A row in venture_links for (plugin `users`, entity = the
 *      account id), which is the same statement made on the venture map. Both
 *      doors exist because the owner arrives from both pages, and the map is
 *      where every other integration is linked.
 *   3. THE HOST. The endpoint's hostname against the ventures' own hosts,
 *      through `shared/host.ts`'s `ventureForHost`, so `api.example.com`
 *      finds `example.com`. This is a GUESS — evidence that two strings look
 *      alike — and it is reported as `matchedBy: "host"` so nothing quotes it
 *      as a decision.
 *
 *      IT USED TO KEY A MAP BY THE REGISTRABLE DOMAIN, which is a bug rather
 *      than a shortcut: folding to the registrable domain is BIDIRECTIONAL by
 *      construction, so a venture on `shop.example.com` and a venture on
 *      `example.com` collapse to one key and one of them silently wins the
 *      map — two businesses filed as one. `ventureForHost` runs the match
 *      downward only, prefers an exact host to a subdomain match however the
 *      roster is ordered, and among subdomain matches gives the host to the
 *      LONGEST venture host, which is the one it is most specifically under.
 *
 * There is deliberately no fourth answer by NAME. Half these labels are two
 * ordinary English words and a venture called "Apps" would collect every
 * product whose label contained it.
 */
import { db, configValue, ventureRow, ventureRows } from "../../db.ts";
import { ventureForHost } from "../../shared/host.ts";
import { PLUGIN } from "./users.ts";

export type VentureRef = {
  id: string;
  slug: string;
  name: string;
  matchedBy: "setting" | "link" | "host";
} | null;

/** `Account label = venture slug`, one per line. Case-insensitive on both,
 *  because "APP-1" and "app-1" are the same account to everyone except a string
 *  compare. */
export function parseMapping(raw: string | null | undefined): { label: string; venture: string }[] {
  const out: { label: string; venture: string }[] = [];
  for (const line of (raw ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const label = t.slice(0, eq).trim();
    const venture = t.slice(eq + 1).trim();
    if (label && venture) out.push({ label, venture });
  }
  return out;
}

/** What is wrong with the mapping, said where it was typed. A venture that
 *  does not exist is the whole point of checking: a typo'd slug would file a
 *  product's users under nothing and look like a product with no venture. */
export function checkMapping(raw: string): string | null {
  const lines = raw.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const line of lines) {
    const eq = line.indexOf("=");
    if (eq < 1)
      return `“${line.slice(0, 40)}” is not a mapping. Each line is “endpoint label = venture slug”.`;
    const venture = line.slice(eq + 1).trim();
    if (!venture) return `“${line.slice(0, eq).trim()}” has no venture after the “=”.`;
    if (!ventureRow(venture))
      return `There is no venture called “${venture}”. The ones there are: ${ventureRows().map((v) => v.slug).slice(0, 8).join(", ")}.`;
  }
  return null;
}

/**
 * Resolve every users account to a venture at once.
 *
 * One call rather than one per account, because both callers — the route and
 * the feed pass — need the whole map and the settings, the links and the
 * ventures are three queries however many accounts there are.
 */
export function ventureFor(
  accounts: { id: number; label: string }[],
  urls: Map<number, string | null>,
): Map<number, VentureRef> {
  const mapping = parseMapping(configValue(PLUGIN, "ventures"));
  const links = new Map(
    (
      db
        .prepare("SELECT entity, venture_id FROM venture_links WHERE plugin = ?")
        .all(PLUGIN) as unknown as { entity: string; venture_id: string }[]
    ).map((r) => [r.entity, r.venture_id]),
  );
  const ventures = ventureRows();

  const out = new Map<number, VentureRef>();
  for (const account of accounts) {
    const typed = mapping.find((m) => m.label.toLowerCase() === account.label.trim().toLowerCase());
    if (typed) {
      const v = ventureRow(typed.venture);
      if (v) {
        out.set(account.id, { id: v.id, slug: v.slug, name: v.name, matchedBy: "setting" });
        continue;
      }
    }
    const linked = links.get(String(account.id));
    if (linked) {
      const v = ventures.find((x) => x.id === linked);
      if (v) {
        out.set(account.id, { id: v.id, slug: v.slug, name: v.name, matchedBy: "link" });
        continue;
      }
    }
    /* A URL that will not parse is not a match, and is already reported as a
       broken endpoint elsewhere — `ventureForHost` answers null for it rather
       than throwing, so there is nothing to catch here. */
    const v = ventureForHost(urls.get(account.id), ventures);
    if (v) {
      out.set(account.id, { id: v.id, slug: v.slug, name: v.name, matchedBy: "host" });
      continue;
    }
    out.set(account.id, null);
  }
  return out;
}
