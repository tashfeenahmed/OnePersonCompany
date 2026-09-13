import type { StoreState } from "./store";
import { isWindowValue } from "./window.ts";

/** A name as a URL segment. Anything that is not a letter, a digit or a dash
 *  becomes a dash, and a name with nothing usable in it still gets an address
 *  rather than an empty one — `fallback` is what it gets, and the server's
 *  ventures use the same rule with "venture" in that slot. */
export function slugify(name: string, fallback = "board"): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

/** The same, with a numeric suffix when the address is already taken — two
 *  boards may share a name, but they cannot share a URL. */
export function uniqueSlug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(name);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Upgrade the saved data format without applying starter content. An absent
 * dashboard/widget may be a deliberate deletion; widths, order and parameters
 * are owner preferences even when a board originally came from a template. */
export function migrateWorkspace(state: StoreState, version: number): StoreState {
  let dashboards = state.dashboards;
  if (dashboards.some(d => !d.slug)) {
    const taken = new Set(dashboards.map(d => d.slug).filter(Boolean));
    dashboards = dashboards.map(d => {
      if (d.slug) return d;
      const slug = uniqueSlug(d.name, taken);
      taken.add(slug);
      return { ...d, slug };
    });
  }
  const dashboardWindow = state.dashboardWindow !== undefined && !isWindowValue(state.dashboardWindow)
    ? undefined : state.dashboardWindow;
  const seedVersion = Math.max(state.seedVersion ?? 0, version);
  return dashboards === state.dashboards && dashboardWindow === state.dashboardWindow && seedVersion === state.seedVersion
    ? state : { ...state, dashboards, dashboardWindow, seedVersion };
}
