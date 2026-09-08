/**
 * A CARD PINNED TO ONE THING, AND WHERE THE LIST OF THINGS COMES FROM.
 *
 * `PlacedWidget.param` is one string on a card. It started as a venture id —
 * "Search · Example App 1" on a global board — and the whole mechanism was written
 * around that one meaning: the picker listed `state.ventures`, the card
 * narrowed every document to the venture's host, and the builder was handed a
 * `project`. The Servers board needs the same card pinned to A MACHINE, and a
 * machine is not a venture in any of those three steps.
 *
 * SO THE KIND IS DECLARED AND THE THREE STEPS ARE LOOKED UP FROM IT. A catalog
 * entry says `perParam: { kind: "server", label: "Server" }`; this file answers
 * the two questions the card and the palette ask — what kind is this, and what
 * are the choices — and the card resolves the chosen id per kind. Adding a
 * third kind is a case in `paramChoices` and a resolution in WidgetCard, and
 * nothing else moves.
 *
 * WHY THE CHOICES ARE NOT ONE LIST. A venture is something the owner typed
 * into this app, so it is in the store and it is there before any provider
 * connects. A box is something an ssh probe found this morning, so it is in the
 * LIVE DOCUMENT and there is no such thing as the list of servers when the
 * plugin is not connected. A seed therefore cannot place a per-server card, and
 * the palette is where those cards come from — which is why an empty choice
 * list is a sentence here rather than an absence.
 */
import type { ParamKind, Widget } from "@/data/widgets";
import type { Venture } from "@/lib/api";
import type { FleetReport } from "@/lib/api/reports";

/** One option in the header's `<select>` and one row in the palette. */
export type ParamChoice = {
  /** What lands in `PlacedWidget.param`. */
  id: string;
  name: string;
  /** The small print at the right of the palette row — a venture's host, a
   *  box's ssh target. Null when there is nothing to add. */
  note: string | null;
};

/**
 * What this catalog entry is pinned to, or null for an ordinary card.
 *
 * `perProject: true` IS `{ kind: "venture" }` and is read as one, so the flag
 * every existing per-project widget carries keeps working untouched and there
 * is exactly one code path underneath.
 */
export function paramKindOf(def: Widget | undefined): ParamKind | null {
  if (!def) return null;
  if (def.perParam) return def.perParam.kind;
  return def.perProject ? "venture" : null;
}

/** The word a sentence uses — "Pick a venture", "no server chosen". */
export const PARAM_NOUN: Record<ParamKind, string> = {
  venture: "venture",
  server: "server",
};

/** The badge the palette prints on the row — "per project", "per server". */
export const PARAM_BADGE: Record<ParamKind, string> = {
  venture: "per project",
  server: "per server",
};

/**
 * Everything a card of this kind could be pinned to.
 *
 * THE FLEET'S ORDER IS THE FLEET DOCUMENT'S ORDER, which is the order the
 * owner added the accounts in — the same order the plugin page lists them, so
 * a machine is in the same place in both. It is deliberately not sorted by how
 * busy a box is: a list that reorders itself between two visits is a list
 * nobody can learn.
 */
export function paramChoices(
  kind: ParamKind,
  sources: { ventures: readonly Venture[]; fleet: FleetReport | null },
): ParamChoice[] {
  if (kind === "venture")
    return sources.ventures.map((v) => ({ id: v.id, name: v.name, note: v.host ?? "no website" }));
  return (sources.fleet?.boxes ?? []).map((b) => ({
    id: String(b.accountId),
    name: b.label,
    /* The hostname the box calls itself, falling back to the ssh target the
       owner typed. A box the probe has never reached has neither, and says so
       rather than showing an empty column. */
    note: b.hostname ?? b.target ?? "never reached",
  }));
}
