import { sidebarPath } from "./navigation.ts";

export type SidebarPin = { type: "page"; path: string } | { type: "session"; sessionId: string } | { type: "dashboard"; dashboardId: string };
type PinPreferences = { pinnedItems?: SidebarPin[]; favoritePaths?: string[] };

export function pinKey(pin: SidebarPin): string {
  return pin.type === "page" ? `page:${pin.path}` : pin.type === "dashboard" ? `dashboard:${pin.dashboardId}` : `session:${pin.sessionId}`;
}

/** Read old favorites until the first pin edit; an explicitly empty list stays empty. */
export function sidebarPins(state: PinPreferences): SidebarPin[] {
  const pins: SidebarPin[] = state.pinnedItems ?? (state.favoritePaths ?? []).map(path => ({ type: "page", path }));
  const seen = new Set<string>();
  return pins.map(pin => pin.type === "page" ? { ...pin, path: sidebarPath(pin.path) } : pin)
    .filter(pin => {
      const key = pinKey(pin);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function togglePin(state: PinPreferences, pin: SidebarPin): SidebarPin[] {
  const pins = sidebarPins(state);
  const canonical = pin.type === "page" ? { ...pin, path: sidebarPath(pin.path) } : pin;
  const key = pinKey(canonical);
  return pins.some(item => pinKey(item) === key)
    ? pins.filter(item => pinKey(item) !== key)
    : [...pins, canonical];
}

/** Keep pins added by another update, and never resurrect removed pins. */
export function reorderPins(state: PinPreferences, keys: string[]): SidebarPin[] {
  const pins = sidebarPins(state);
  const remaining = new Map(pins.map(pin => [pinKey(pin), pin]));
  const ordered: SidebarPin[] = [];
  for (const key of keys) {
    const pin = remaining.get(key);
    if (pin) { ordered.push(pin); remaining.delete(key); }
  }
  return [...ordered, ...remaining.values()];
}
