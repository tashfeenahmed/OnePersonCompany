/**
 * ONE VENTURE OUT OF MANY, AS A MENU.
 *
 * The run apps chose a venture from a row of chips — one per venture, with
 * its mark and its stage — which was the right control at four ventures and
 * a wall at nineteen. A menu shows the chosen one and opens into the same
 * list, marks and stages included, so the row reads as a field rather than a
 * roster. The Chat page's own picker is this shape already; this is the
 * reusable one, for every "for which venture" the app has.
 */
import { ChevronDown, FolderClosed } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { cn } from "@/lib/utils";
import type { Venture } from "@/lib/store";

export function VentureSelect({
  ventures,
  value,
  onChange,
  none = null,
  className,
}: {
  ventures: Venture[];
  /** The chosen venture's id, or null for none. */
  value: string | null;
  onChange: (id: string | null) => void;
  /** The label of a "no venture" row, or null when one is required. */
  none?: string | null;
  className?: string;
}) {
  const chosen = ventures.find((v) => v.id === value) ?? null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "hover:border-line-strong flex h-9 max-w-full items-center gap-2 rounded-[9px] border px-2.5 text-left text-[12.5px] transition-colors",
          className,
        )}
      >
        {chosen ? (
          <VentureMark venture={chosen} size={15} />
        ) : (
          <FolderClosed className="text-muted-foreground size-3.5" strokeWidth={1.6} />
        )}
        <span className="min-w-0 truncate">{chosen?.name ?? none ?? "Choose a venture"}</span>
        {chosen && <StagePill stage={chosen.stage} />}
        <ChevronDown className="text-muted-foreground ml-auto size-[13px] shrink-0" strokeWidth={1.6} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[60vh] w-64 overflow-y-auto">
        {none !== null && (
          <DropdownMenuItem onSelect={() => onChange(null)}>
            <span className="border-border size-[7px] shrink-0 rounded-[2px] border" />
            {none}
          </DropdownMenuItem>
        )}
        {ventures.map((v) => (
          <DropdownMenuItem key={v.id} onSelect={() => onChange(v.id)}>
            <VentureMark venture={v} size={14} />
            <span className="min-w-0 truncate">{v.name}</span>
            <span className="ml-auto">
              <StagePill stage={v.stage} />
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
