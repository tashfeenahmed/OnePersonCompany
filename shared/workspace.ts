type Obj = Record<string, unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max = 300): v is string => typeof v === "string" && v.length <= max;
const ref = (v: unknown) => v === null || v === undefined || text(v, 200);
const unique = (items: Obj[], key: string) => new Set(items.map(x => x[key])).size === items.length;
const list = (v: unknown, check: (x: Obj) => boolean, max = 5000): v is Obj[] =>
  Array.isArray(v) && v.length <= max && v.every(x => object(x) && check(x)) && unique(v, "id");
export function isWorkspacePreferences(v: unknown): boolean {
  if (!object(v) || !object(v.workspace)) return false;
  const w = v.workspace;
  if (!text(w.name) || !text(w.owner) || !ref(w.defaultVentureId)) return false;
  if (v.seedVersion !== undefined && (!Number.isInteger(v.seedVersion) || Number(v.seedVersion) < 0)) return false;
  if (v.favoritePaths !== undefined && (!Array.isArray(v.favoritePaths) || v.favoritePaths.length > 100 || !v.favoritePaths.every(x => typeof x === "string" && /^\/[a-z][a-z0-9/-]*$/.test(x)) || new Set(v.favoritePaths).size !== v.favoritePaths.length)) return false;
  if (v.pinnedItems !== undefined) {
    if (!Array.isArray(v.pinnedItems) || v.pinnedItems.length > 5200 || !v.pinnedItems.every(pin => object(pin) && (
      pin.type === "page" ? text(pin.path, 300) && /^\/[a-z][a-z0-9/-]*$/.test(pin.path)
        : pin.type === "session" && text(pin.sessionId, 200) && !!pin.sessionId
    ))) return false;
    const keys = v.pinnedItems.map(pin => pin.type === "page" ? `page:${pin.path}` : `session:${pin.sessionId}`);
    if (new Set(keys).size !== keys.length) return false;
  }
  /* The chrome's palette: one of the ids in client/src/lib/palettes.ts, or
     absent for the default. Checked by SHAPE rather than against that list —
     shared/ is read by the server too and must not import a client module, and
     a document written by a newer client that has one more palette in it is
     not an invalid document. An id this client cannot draw falls back to the
     default at read time. */
  if (v.palette !== undefined && !(typeof v.palette === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(v.palette))) return false;
  /* The sidebar's one list in the owner's order — see shared/sidebarNav.ts.
     The same shape as favoritePaths: bounded, unique, paths only. */
  if (v.navOrder !== undefined && (!Array.isArray(v.navOrder) || v.navOrder.length > 100 || !v.navOrder.every(x => typeof x === "string" && /^\/[a-z][a-z0-9/-]*$/.test(x)) || new Set(v.navOrder).size !== v.navOrder.length)) return false;
  if (v.appOrder !== undefined && (!Array.isArray(v.appOrder) || v.appOrder.length > 200 || !v.appOrder.every(x => text(x, 100)) || new Set(v.appOrder).size !== v.appOrder.length)) return false;
  if (!list(v.sessions, s => text(s.id, 200) && !!s.id && text(s.title, 2000) && ref(s.ventureId)
    && (s.seeded === undefined || typeof s.seeded === "boolean")
    && (s.children === undefined || list(s.children, c => text(c.id, 200) && text(c.title, 2000) && ref(c.to) && ref(c.status))))) return false;
  if (!list(v.dashboards, d => text(d.id, 200) && !!d.id && text(d.name) && text(d.slug, 200) && !!d.slug && ref(d.ventureId)
    /* `param` is what a PINNED card is pinned to — a venture id, a fleet
       account id — see PlacedWidget in client/src/lib/store.tsx. Which kind
       it is comes from the catalog entry and is a client-side fact, so this
       stays a non-empty string of bounded length: a venture deleted, or a box
       removed, since the card was placed is a card that says so, not an
       invalid document. */
    && list(d.widgets, x => text(x.id, 200) && !!x.id && text(x.type, 200) && [1, 2, 4].includes(Number(x.w)) && typeof x.w === "number"
      && (x.span === undefined || (typeof x.span === "number" && [3, 4, 5, 6, 7, 8, 9, 12].includes(x.span)))
      && (x.param === undefined || (text(x.param, 200) && !!x.param)), 500), 200)) return false;
  const slugs = (v.dashboards as Obj[]).map(d => `${d.ventureId ?? ""}/${d.slug}`);
  return new Set(slugs).size === slugs.length;
}
