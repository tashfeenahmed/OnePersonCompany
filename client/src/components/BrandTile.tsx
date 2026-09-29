import { cn } from "@/lib/utils";
import { BRAND_ICONS } from "@/data/brandIcons";
import { readableColour, tileBackground } from "@/lib/readableColour";

/**
 * A rounded service tile: the real brand glyph on a tint of its own colour, or
 * a tinted monogram when the service has no brand mark anywhere (Dynadot,
 * FreeLLMAPI, our own uptime probe).
 */
export function BrandTile({
  icon,
  name,
  mono,
  tint,
  className,
  glyphClassName,
}: {
  icon?: string | null;
  name?: string;
  mono?: string;
  tint?: string;
  className?: string;
  glyphClassName?: string;
}) {
  const brand = icon ? BRAND_ICONS[icon] : undefined;
  const colour = brand?.hex ?? tint ?? "#8b8981";

  return (
    <div
      className={cn(
        "grid size-[34px] shrink-0 place-items-center rounded-[12px]",
        className,
      )}
      style={{ background: tileBackground(colour) }}
    >
      {brand ? (
        <svg
          viewBox="0 0 24 24"
          fill={readableColour(colour)}
          className={cn("size-[17px]", glyphClassName)}
          aria-hidden
          dangerouslySetInnerHTML={{ __html: brand.svg }}
        />
      ) : (
        /* Centred as a box, not as a line of text: a glyph class that sizes
           the span (`size-[11px]`) would otherwise pin the digit to the top
           left of its line box, and a lone "1" shows it most. */
        <span
          className={cn(
            "inline-flex items-center justify-center text-[14px] leading-none font-semibold tracking-tight",
            glyphClassName,
          )}
          style={{ color: readableColour(colour) }}
        >
          {mono ?? name?.[0] ?? "?"}
        </span>
      )}
    </div>
  );
}
