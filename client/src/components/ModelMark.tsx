import { MODEL_MARKS, modelHouse, monogram } from "@/data/modelMarks";
import { cn } from "@/lib/utils";

/**
 * A small square beside a model's name.
 *
 * Reinforcement, never replacement: the name stays in text next to it,
 * because a logo alone cannot be read by anyone who does not already know it
 * and cannot be found with ctrl-F. That is also why the mark is aria-hidden —
 * to a screen reader it is decoration, and the name is the label.
 *
 * A brand with no verified path gets its initials in a muted tile rather than
 * a generic robot or, far worse, some other company's logo.
 */
export function ModelMark({
  name,
  size = 16,
  className,
}: {
  /** A model or provider name — `google/gemini-3.7-flash` or `gpt-5.6-luna`. */
  name: string;
  size?: number;
  className?: string;
}) {
  const house = modelHouse(name);
  const mark = MODEL_MARKS[house];
  if (!mark)
    return (
      <span
        aria-hidden
        title={house}
        style={{ width: size, height: size, fontSize: Math.max(7, size * 0.5) }}
        className={cn(
          "bg-muted text-muted-foreground inline-flex shrink-0 items-center justify-center rounded-[4px] leading-none font-medium tracking-tight",
          className,
        )}
      >
        {monogram(house)}
      </span>
    );
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${mark.box} ${mark.box}`}
      width={size}
      height={size}
      fill="currentColor"
      className={cn("inline-block shrink-0 opacity-80", className)}
    >
      <title>{house}</title>
      <path d={mark.d} />
    </svg>
  );
}
