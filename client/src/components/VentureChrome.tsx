import { cn } from "@/lib/utils";
import { VENTURE_STAGES, type VentureStage } from "@/lib/api";

/**
 * The two small pieces of venture chrome that appear on five different pages:
 * the mark and the stage pill. Kept together because they are always drawn
 * together — a venture is recognised by its icon and understood by its stage —
 * and kept out of the pages because a fifth copy of either would be the one
 * that drifts.
 */

/**
 * A VENTURE, THE SIZE OF A FAVICON.
 *
 * The site's own icon when it was readable, and the venture's colour when it
 * was not — never a letter in a circle, which is what an app draws when it
 * would rather look complete than say what it knows. The colour square is not
 * a placeholder: for a venture with no website there is nothing else to draw
 * and the colour IS the identity, the same square that has always been in the
 * chat picker and on the board's chips.
 *
 * The favicon is a data: URL stored on the venture, so this makes no request
 * and keeps working with the site down. `onError` falls back to the square,
 * because a stored icon can still be a broken image — an SVG with a namespace
 * problem, a truncated PNG — and a broken-image glyph beside a venture's name
 * looks like the app is wrong rather than the icon.
 */
export function VentureMark({
  venture,
  size = 18,
  className,
}: {
  venture: { name: string; color: string; brand?: { favicon: string | null } };
  size?: number;
  className?: string;
}) {
  const favicon = venture.brand?.favicon ?? null;
  if (favicon)
    return (
      <img
        src={favicon}
        alt=""
        width={size}
        height={size}
        onError={(e) => {
          e.currentTarget.style.display = "none";
        }}
        className={cn("shrink-0 rounded-[4px] object-contain", className)}
        style={{ width: size, height: size }}
      />
    );
  return (
    <span
      aria-hidden
      className={cn("shrink-0 rounded-[3px]", className)}
      style={{
        background: venture.color,
        /* A colour square reads as a marker rather than an icon, so it is
           drawn smaller than the space a favicon would fill and centred in it
           — otherwise a list of ventures where some have icons and some do not
           looks like two different lists. */
        width: Math.round(size * 0.55),
        height: Math.round(size * 0.55),
        margin: Math.round(size * 0.225),
      }}
    />
  );
}

/**
 * WHICH STAGE THIS VENTURE IS AT, in a word.
 *
 * Three muted tones rather than three bright ones: the stage is context for
 * everything else on the page, not an alarm. It is deliberately not a
 * traffic-light scale either — an idea is not "bad" and a launched product is
 * not "good", they are different jobs — so the tones are three neutrals with
 * enough distance to tell apart at a glance.
 *
 * The title carries the whole sentence, because the pill is a label and the
 * sentence is what actually changes the advice the agent gives.
 */
export function StagePill({ stage, className }: { stage: VentureStage; className?: string }) {
  const spec = VENTURE_STAGES.find((s) => s.id === stage);
  return (
    <span
      title={spec?.note}
      className={cn(
        "shrink-0 rounded-[6px] border px-1.5 py-px text-[10.5px] leading-[1.5] whitespace-nowrap",
        stage === "idea" && "text-muted-foreground border-dashed",
        stage === "pre-launch" && "text-warn border-warn/40",
        stage === "launched" && "text-ok border-ok/40",
        className,
      )}
    >
      {spec?.label ?? stage}
    </span>
  );
}
