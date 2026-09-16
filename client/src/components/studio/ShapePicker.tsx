import { useId } from "react";
import { cn } from "@/lib/utils";

export function ShapePicker<T extends string>({ value, onChange, options, label = "Shape" }: {
  value: T;
  onChange: (value: T) => void;
  options: { key: T; label: string; ratio: string }[];
  label?: string;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-3 gap-1.5">
      {options.map((option) => {
        const [width, height] = option.ratio.split(":").map(Number);
        const scale = 30 / Math.max(width, height);
        return (
          <label key={option.key} className="relative min-w-0 cursor-pointer">
            <input
              type="radio" name={name} value={option.key} checked={value === option.key}
              onChange={() => onChange(option.key)} className="peer sr-only"
            />
            <span className={cn(
              "flex h-full flex-col items-center gap-1 rounded-xl border px-1.5 py-2.5 text-[12px] transition-colors",
              "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
              value === option.key ? "border-foreground bg-accent text-foreground" : "border-line-soft text-muted-foreground hover:border-line-strong hover:text-foreground",
            )}>
              <span aria-hidden="true" className="flex h-8 items-center justify-center">
                <span className="rounded-[3px] border-[1.5px] border-current bg-current/5" style={{ width: width * scale, height: height * scale }} />
              </span>
              <span className="font-medium">{option.label}</span>
              <span className="text-muted-foreground text-[11px] leading-none">{option.ratio}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}
