import { PLUGINS } from "@/data/plugins";

/**
 * WHAT AN INTEGRATION LOOKS LIKE WHEN IT IS NAMED BY A LINK ROW.
 *
 * The link table stores an integration's ID and nothing else about it — that
 * is the right shape for a join and the wrong shape for a chip, which needs a
 * name, a glyph and somewhere to go. The catalog in `data/plugins.ts` has all
 * three, so this is the lookup between them.
 *
 * IT NEVER RETURNS NOTHING. A link can name an integration the catalog has not
 * got: one added on the server before the catalog caught up, or one whose
 * entity listing exists before its card does. Falling back to a tidied id and
 * a letter keeps the row readable and, more to the point, keeps it REMOVABLE —
 * a link nobody can see is a link nobody can unlink.
 *
 * THE ONE ALIAS is `products`. The entity listing is served at
 * `/api/products/entities` and the catalog entry is `product-stats`, because
 * one names a route and the other names a credential. Two ids for one thing is
 * a fact about the server, not a decision this file gets to make, so it is
 * written down here rather than argued with.
 */
const ALIASES: Record<string, string> = { products: "product-stats" };

export type PluginLook = {
  /** The catalog id, after aliasing — where /integrations/<id> lives. */
  id: string;
  name: string;
  /** Simple Icons slug for `BrandTile`, or null when the service has no mark. */
  icon: string | null;
  mono?: string;
  tint?: string;
  /** False when the catalog has never heard of it, so a page can say so
   *  rather than draw a confident-looking tile for a guess. */
  known: boolean;
};

export function pluginLook(plugin: string): PluginLook {
  const id = ALIASES[plugin] ?? plugin;
  const found = PLUGINS.find((p) => p.id === id);
  if (found)
    return {
      id,
      name: found.name,
      icon: found.icon,
      mono: found.mono,
      tint: found.tint,
      known: true,
    };
  return {
    id,
    /* "bing-webmaster" reads as "Bing webmaster" rather than as an id. Only
       the first word is capitalised: guessing at "Webmaster" versus
       "webmaster" for a service nobody here has a record of would be inventing
       a brand's own typography. */
    name: id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase()),
    icon: null,
    mono: id[0]?.toUpperCase(),
    known: false,
  };
}

/** Plugin ids in the order a person reads them: the ones with a catalog entry
 *  first, alphabetically by the name they are shown under. */
export function byPluginName(a: string, b: string): number {
  return pluginLook(a).name.localeCompare(pluginLook(b).name);
}
