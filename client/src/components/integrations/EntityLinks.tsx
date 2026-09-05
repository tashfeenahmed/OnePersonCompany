import { useState } from "react";
import { Link } from "react-router-dom";
import { Link2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { integrations, type VentureMap } from "@/lib/api/integrations";

/**
 * WHICH VENTURES THIS ONE THING BELONGS TO, and the one click that says so.
 *
 * Every panel in this directory lists things — websites, boxes, packages,
 * hosts, endpoints — and every one of them is a thing a venture can own. The
 * question "whose is this?" is asked standing in front of the row, not on a
 * separate page, so the answer and the way to give it are both here.
 *
 * THE CHIP IS THE VENTURE'S OWN COLOUR because that is the colour the same
 * venture is drawn in on the map, on its cards and in its dashboards. A second
 * palette for the same set of things would make two different pages disagree
 * about which one is Example App 1.
 *
 * NOTHING HERE INFERS A LINK. The edges come from `venture_links`, which is
 * the owner's own statement — `source: "auto"` was proposed from a hostname
 * and accepted in bulk, `"owner"` was linked one at a time — and this
 * component's button writes the second kind. A row with no chip is a row
 * nobody has claimed, which is different from a row that belongs to nothing.
 *
 * `present: false` never reaches the eye here: it is an edge whose entity is
 * temporarily unlisted, and this component is only ever rendered NEXT TO the
 * entity, so by definition the thing is present.
 */
export function EntityLinks({
  map,
  plugin,
  entity,
  label,
  onLinked,
}: {
  map: VentureMap | null;
  plugin: string;
  entity: string;
  /** Carried to the server so the link reads as something in the map even if
   *  this integration later stops listing the entity. */
  label?: string | null;
  onLinked: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!map) return null;

  const linked = map.edges
    .filter((e) => e.plugin === plugin && e.entity === entity)
    .map((e) => ({ edge: e, venture: map.ventures.find((v) => v.id === e.venture) }))
    .filter((x) => x.venture);

  const linkedIds = new Set(linked.map((x) => x.venture!.id));
  const available = map.ventures.filter((v) => !linkedIds.has(v.id));

  async function link(slug: string) {
    setBusy(true);
    setProblem(null);
    try {
      await integrations.linkVenture(slug, plugin, entity, label ?? undefined);
      onLinked();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {linked.map(({ edge, venture }) => (
        <Link
          key={venture!.id}
          to={`/ventures/${venture!.slug}/connections`}
          title={
            edge.source === "owner"
              ? `Linked to ${venture!.name} by hand`
              : `Suggested from a hostname and accepted for ${venture!.name}`
          }
          className="hover:border-line-strong inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors"
        >
          <span
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: venture!.color }}
          />
          {venture!.name}
        </Link>
      ))}

      {!!available.length && (
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] disabled:opacity-50"
          >
            <Link2 className="size-3" strokeWidth={1.6} />
            {linked.length ? "Link to another venture…" : "Link to venture…"}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[200px]">
            <DropdownMenuLabel className="text-[11px] font-normal">
              This is part of…
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {available.map((v) => (
              <DropdownMenuItem key={v.id} onSelect={() => void link(v.slug)}>
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: v.color }}
                />
                {v.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      {problem && <span className="text-destructive text-[11px]">{problem}</span>}
    </div>
  );
}
