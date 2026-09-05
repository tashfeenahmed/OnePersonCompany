/**
 * WHAT THERE IS TO LINK A VENTURE TO, gathered from every integration on this
 * box, and the rules for guessing which venture each thing belongs to.
 *
 * THE TWO HALVES, AND WHY THEY ARE GATHERED DIFFERENTLY.
 *
 *   BUILT-IN TABLES are read straight out of the database, here. A Cloudflare
 *   zone, a Search Console property, a registrar's domain, a GitHub repo, an
 *   npm package, a Stripe product, an app in either store, a Meta Page, a
 *   Resend sending domain, a Gmail mailbox: twenty-odd integrations shipped
 *   before the manifest seam existed, their tables are in db.ts, and reading
 *   them is a SELECT. Going through their routes instead would mean nineteen
 *   loopback fetches to re-shape documents this file would then have to parse.
 *
 *   THE MANIFEST AREAS are asked over loopback, at `GET /api/<plugin>/
 *   entities`, because their tables are not this file's business and their
 *   areas ship independently of it. A 404 there means "that area is not built
 *   yet, or has nothing" — which is a fact worth reporting rather than an
 *   error worth failing on, so every ask is recorded with its outcome and the
 *   caller can see which sources were consulted and which were silent.
 *
 * AN ENTITY IS KEYED BY THE PROVIDER'S OWN IDENTIFIER. A zone is its zone id,
 * not its name; an app is its app id, not its title. That is what makes a link
 * survive a rename, and it is why `label` travels beside `entity` — the key is
 * for pointing at the thing, the label is for drawing it.
 *
 * MATCHING IS A GUESS AND THE DOCUMENT SAYS SO. Every suggestion carries a
 * `why` in the plainest words available — "the Cloudflare zone is named
 * example-app-1.example.test, which is this venture's host" — because a suggestion the owner
 * cannot audit is a suggestion they will accept wrongly. Nothing here links
 * anything: `POST accept-all` does, deliberately, in one place the owner
 * pressed.
 *
 * WHAT IS DELIBERATELY NOT MATCHED. A parent host does NOT claim a venture at
 * a different second-level domain: example.ie and neu.so are two businesses on
 * this very box, and "endsWith" over the wrong pair of hosts would file one
 * under the other for ever. Subdomains match their parent (api.example-app-1.example.test is
 * example-app-1.example.test's), and the direction is stated in the `why`.
 */
import {
  allDomains,
  allGithubRepos,
  appStoreApps,
  bingSites,
  cloudflareRegistrar,
  cloudflareZones,
  db,
  gmailMailboxes,
  gscSites,
  metaPages,
  npmPackages,
  resendDomains,
  stripeSubscriptions,
  type VentureRow,
} from "../../db.ts";
import { PORT } from "../../config.ts";

/** One thing a venture can be linked to. `host` is a hostname the entity is
 *  obviously ABOUT — the contract every area's `/entities` route keeps too —
 *  and null where there is none, which is not the same as "no match". */
export type Entity = {
  plugin: string;
  entity: string;
  label: string;
  host: string | null;
};

/** An entity plus the sentence saying why this venture might own it. */
export type Suggestion = Entity & { why: string };

/** Which sources were consulted for a listing, and what each one said. The
 *  document ships this so "nothing from Umami" and "Umami was never asked"
 *  never read the same. */
export type SourceNote = {
  plugin: string;
  ok: boolean;
  entities: number;
  note: string | null;
};

/* ------------------------------------------------------------------ hosts */

/**
 * A hostname out of whatever the provider stored — a bare host, a URL, or
 * Search Console's `sc-domain:` prefix.
 *
 * Lowercased, `www.` removed and the trailing dot dropped, because the
 * ventures table stores hosts that way (see the `host` column's comment in
 * db.ts) and two spellings of one host is two things that never match.
 */
export function hostOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = String(raw).trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith("sc-domain:")) v = v.slice("sc-domain:".length);
  if (v.includes("://")) {
    try {
      v = new URL(v).hostname;
    } catch {
      return null;
    }
  } else {
    v = v.split("/")[0]!.split("?")[0]!;
  }
  v = v.replace(/\.$/, "").replace(/^www\./, "");
  if (!v || !v.includes(".") || /\s/.test(v)) return null;
  return v;
}

/**
 * Does this entity's host belong to this venture's?
 *
 * EQUAL, OR A SUBDOMAIN OF IT — and in that direction only. `api.example.ie`
 * belongs to `example.ie`; `example.ie` does not belong to `api.example.ie`, and neither
 * of them has anything to do with `neu.so`. The one-directional rule is the
 * whole of the protection against filing two businesses under one name, and
 * this box has exactly that pair in it.
 */
function hostMatch(ventureHost: string, entityHost: string): "same" | "sub" | null {
  if (ventureHost === entityHost) return "same";
  if (entityHost.endsWith(`.${ventureHost}`)) return "sub";
  return null;
}

/* ------------------------------------------------------------------ names */

/** A name reduced to what two spellings of it have in common. "Free LLM API"
 *  and "FreeLLMAPI" are the same product; "free-llm-api" is too. */
function squash(raw: string | null | undefined): string {
  return String(raw ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * The shortest a squashed name may be before it is allowed to match by name
 * alone. Three characters matches half the noun phrases in a portfolio; at
 * five, "neuie" and "example-app-1" still work and "ob1" no longer sweeps up every
 * label with an o, a b and a 1 in it.
 */
const MIN_NAME = 5;

function nameMatch(venture: VentureRow, label: string): boolean {
  /*
    AN OWNER IS NOT A NAME. A GitHub repo is labelled `owner/repo`, and the
    owner half is the same login on every one of them — so a venture named
    after the person (the portfolio site) read as every repository the person
    has ever made: thirty-one links accepted in one press, thirty of them
    wrong. Only the part after the last slash is a thing's own name; the part
    before it is whose it is, which every entity on this box shares.
  */
  const l = squash(label.includes("/") ? label.slice(label.lastIndexOf("/") + 1) : label);
  if (!l) return false;
  for (const candidate of [venture.name, venture.slug]) {
    const v = squash(candidate);
    if (v.length < MIN_NAME) continue;
    if (l === v || l.includes(v)) return true;
  }
  return false;
}

/* ------------------------------------------------- the built-in integrations */

/**
 * Every entity the pre-manifest integrations hold, from their own tables.
 *
 * Each block is one integration, keyed by the id its plugins row uses, so a
 * link written here points at the same plugin the Integrations page draws. A
 * table that is empty contributes nothing and costs one SELECT.
 */
export function builtinEntities(): Entity[] {
  const out: Entity[] = [];

  /* Cloudflare: the zone id is the key, the zone NAME is a hostname, and it is
     the single most reliable join on this box — a zone is a domain. */
  for (const z of cloudflareZones())
    out.push({ plugin: "cloudflare", entity: z.zone_id, label: z.name, host: hostOf(z.name) });

  /* Cloudflare's registrar side, which is a different list from the zones: a
     domain can be registered here and served elsewhere, or the reverse. */
  for (const d of cloudflareRegistrar())
    out.push({
      plugin: "cloudflare",
      entity: `registrar:${d.name}`,
      label: `${d.name} (registrar)`,
      host: hostOf(d.name),
    });

  /* The two registrars. `source` IS the plugin id — a domain row knows which
     door read it — so a link points at dynadot or spaceship rather than at a
     "domains" plugin that has no page of its own. */
  for (const d of allDomains())
    out.push({
      plugin: d.source,
      entity: d.name,
      label: `${d.name} (${d.registrar})`,
      host: hostOf(d.name),
    });

  /* Search Console. The property string is the key — `sc-domain:example-app-1.example.test`
     — and it is what gsc_days, gsc_queries and gsc_pages are all keyed by, so
     an audit joining search data joins on exactly this. */
  for (const s of gscSites())
    out.push({ plugin: "gsc", entity: s.property, label: s.property, host: hostOf(s.property) });

  for (const s of bingSites())
    out.push({ plugin: "bing-webmaster", entity: s.site, label: s.site, host: hostOf(s.site) });

  /* GitHub: the repo's HOMEPAGE is the hostname it is about, not the repo URL
     — every repo here is on github.com and that would match nothing. */
  for (const r of allGithubRepos())
    out.push({
      plugin: "github",
      entity: r.full_name,
      label: r.full_name,
      host: hostOf(r.homepage),
    });

  /* npm: a package name is not a hostname and there is no field that is one,
     so these can only ever be matched by name or linked by hand. */
  for (const p of npmPackages())
    out.push({ plugin: "npm", entity: p.package, label: p.package, host: null });

  /* Stripe PRODUCTS rather than subscriptions: a venture sells a product, and
     a subscription is one customer's copy of it. De-duplicated by name, which
     is also the key, because the product id is not in this table. */
  const products = new Set<string>();
  for (const s of stripeSubscriptions()) {
    const name = (s.product ?? "").trim();
    if (!name || products.has(name)) continue;
    products.add(name);
    out.push({ plugin: "stripe", entity: name, label: name, host: null });
  }

  /* The app stores. The bundle id is a reversed hostname by convention — the
     convention Apple and Google both document — so it is read as one, and the
     `why` says it was read rather than reported. */
  for (const a of appStoreApps())
    out.push({
      plugin: "appstore",
      entity: a.app_id,
      label: a.name ?? a.bundle_id ?? a.app_id,
      host: hostFromBundle(a.bundle_id),
    });

  for (const r of db
    .prepare("SELECT DISTINCT package FROM play_stats ORDER BY package")
    .all() as unknown as { package: string }[])
    out.push({
      plugin: "playstore",
      entity: r.package,
      label: r.package,
      host: hostFromBundle(r.package),
    });

  /* Meta Pages have a facebook.com link and no host of their own. Name only. */
  for (const p of metaPages())
    out.push({
      plugin: "meta",
      entity: p.page_id,
      label: p.name ?? p.page_id,
      host: null,
    });

  for (const d of resendDomains())
    out.push({
      plugin: "resend",
      entity: d.domain_id,
      label: d.name,
      host: hostOf(d.name),
    });

  /* A mailbox's host is its address's domain. For a gmail.com address that
     matches nothing, which is correct: the mailbox is the owner's, not a
     venture's, and it should be linked by hand if it is linked at all. */
  for (const m of gmailMailboxes())
    out.push({
      plugin: "gmail",
      entity: String(m.account_id),
      label: m.address ?? m.account_label,
      host: m.address ? hostOf(m.address.split("@")[1] ?? "") : null,
    });

  return out;
}

/**
 * A hostname out of a bundle id, or null.
 *
 * `test.example.mobile` is `example-app-10.example.test` and `com.example-video.app` is
 * `video.example.test`. It is a READING of a convention rather than a fact the
 * store reported, so it is only attempted when the first segment is actually a
 * TLD — otherwise `com.example.thing` would produce a host for anything.
 */
const BUNDLE_TLDS = new Set([
  "com", "co", "io", "ie", "app", "ai", "net", "org", "dev", "me", "so", "fyi", "uk",
]);

function hostFromBundle(bundle: string | null | undefined): string | null {
  const parts = String(bundle ?? "").toLowerCase().split(".");
  if (parts.length < 2) return null;
  const [tld, name] = parts;
  if (!tld || !name || !BUNDLE_TLDS.has(tld)) return null;
  if (!/^[a-z0-9-]{2,}$/.test(name)) return null;
  return `${name}.${tld}`;
}

/* -------------------------------------------------- the manifest integrations */

/**
 * The areas that ship their own tables, asked over loopback.
 *
 * THE LIST IS WRITTEN DOWN RATHER THAN DISCOVERED, because there is nothing to
 * discover it from: an area's manifest names its routers, not which of them
 * publish entities, and asking every mounted path for `/entities` would be a
 * scan of somebody else's routes. These are the ids the four areas' briefs
 * name; one that does not exist yet answers 404, which is recorded and costs
 * nothing else.
 */
const MANIFEST_PLUGINS = [
  "umami",
  "pypi",
  "bluesky",
  "uptime",
  "fleet",
  "products",
  "backlinks",
  "presence",
];

/** Short, because this is a loopback call to this same process and a slow one
 *  would be holding the request that is asking for it. */
const LOOPBACK_MS = 3_000;

export async function loopbackEntities(): Promise<{
  entities: Entity[];
  sources: SourceNote[];
}> {
  const entities: Entity[] = [];
  const sources: SourceNote[] = [];

  await Promise.all(
    MANIFEST_PLUGINS.map(async (plugin) => {
      const url = `http://127.0.0.1:${PORT}/api/${plugin}/entities`;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(LOOPBACK_MS) });
        if (res.status === 404) {
          sources.push({
            plugin,
            ok: true,
            entities: 0,
            note: "No such route — that integration is not built here yet.",
          });
          return;
        }
        if (!res.ok) {
          sources.push({ plugin, ok: false, entities: 0, note: `HTTP ${res.status}` });
          return;
        }
        const doc = (await res.json()) as unknown;
        /* Both shapes are accepted: a bare array, and `{ entities: [...] }`.
           The contract in the brief is the list; a route that wrapped it has
           not broken anything worth a warning. */
        const raw = Array.isArray(doc)
          ? doc
          : Array.isArray((doc as { entities?: unknown })?.entities)
            ? ((doc as { entities: unknown[] }).entities)
            : null;
        if (!raw) {
          sources.push({
            plugin,
            ok: false,
            entities: 0,
            note: "Answered, but not with a list of entities.",
          });
          return;
        }
        let n = 0;
        for (const item of raw) {
          const e = item as Partial<Entity>;
          if (typeof e?.entity !== "string" || !e.entity) continue;
          entities.push({
            plugin: typeof e.plugin === "string" && e.plugin ? e.plugin : plugin,
            entity: e.entity,
            label: typeof e.label === "string" && e.label ? e.label : e.entity,
            host: hostOf(typeof e.host === "string" ? e.host : null),
          });
          n += 1;
        }
        sources.push({ plugin, ok: true, entities: n, note: null });
      } catch (err) {
        sources.push({
          plugin,
          ok: false,
          entities: 0,
          note: err instanceof Error ? err.name : "Error",
        });
      }
    }),
  );

  entities.sort((a, b) => a.plugin.localeCompare(b.plugin) || a.entity.localeCompare(b.entity));
  sources.sort((a, b) => a.plugin.localeCompare(b.plugin));
  return { entities, sources };
}

/* ------------------------------------------------------------------- both */

export async function allEntities(): Promise<{
  entities: Entity[];
  sources: SourceNote[];
}> {
  const builtin = builtinEntities();
  const { entities: manifest, sources } = await loopbackEntities();
  return {
    entities: [...builtin, ...manifest],
    sources: [
      {
        plugin: "(built-in tables)",
        ok: true,
        entities: builtin.length,
        note:
          "Cloudflare, the registrars, Search Console, Bing, GitHub, npm, Stripe, " +
          "both app stores, Meta, Resend and Gmail — read from their own tables " +
          "rather than over HTTP.",
      },
      ...sources,
    ],
  };
}

/* ------------------------------------------------------------ the guessing */

/**
 * What this venture probably owns, out of everything there is.
 *
 * `linked` is what it already owns, keyed `plugin entity`; those are not
 * suggested again — a suggestion the owner has already accepted is noise, and
 * accepting it twice is a no-op that looks like a change.
 */
export function suggestFor(
  venture: VentureRow,
  entities: Entity[],
  linked: Set<string>,
): Suggestion[] {
  const vhost = hostOf(venture.host ?? venture.website);
  const out: Suggestion[] = [];

  for (const e of entities) {
    if (linked.has(`${e.plugin} ${e.entity}`)) continue;

    let why: string | null = null;

    if (vhost && e.host) {
      const kind = hostMatch(vhost, e.host);
      if (kind === "same")
        why = `${e.plugin} has ${e.host}, which is ${venture.name}'s own host.`;
      else if (kind === "sub")
        why = `${e.host} is a subdomain of ${vhost}, ${venture.name}'s host.`;
    }

    if (!why && nameMatch(venture, e.label))
      why =
        `${e.plugin} calls this “${e.label}”, which reads as ${venture.name}. ` +
        `A name is a weaker match than a hostname — check it before accepting.`;

    if (why) out.push({ ...e, why });
  }

  /* Host matches first, then by plugin, so the strong evidence is at the top
     of a list somebody is going to accept in bulk. */
  return out.sort((a, b) => {
    const an = a.why.includes("reads as") ? 1 : 0;
    const bn = b.why.includes("reads as") ? 1 : 0;
    return an - bn || a.plugin.localeCompare(b.plugin) || a.entity.localeCompare(b.entity);
  });
}
