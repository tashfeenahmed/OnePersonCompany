import { cn } from "@/lib/utils";
import { BRAND_ICONS } from "@/data/brandIcons";

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
      style={{ background: `${colour}1f` }}
    >
      {brand ? (
        <svg
          viewBox="0 0 24 24"
          fill={colour}
          className={cn("size-[17px]", glyphClassName)}
          aria-hidden
          dangerouslySetInnerHTML={{ __html: brand.svg }}
        />
      ) : (
        <span
          className={cn(
            "text-[14px] font-semibold tracking-tight",
            glyphClassName,
          )}
          style={{ color: colour }}
        >
          {mono ?? name?.[0] ?? "?"}
        </span>
      )}
    </div>
  );
}
