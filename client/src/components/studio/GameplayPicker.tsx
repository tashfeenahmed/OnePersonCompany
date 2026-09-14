import { useId, useState } from "react";
import { Check, ImageOff, Shuffle } from "lucide-react";
import type { GameplayBackground } from "../../../../shared/gameplay";
import { cn } from "@/lib/utils";

export function GameplayPicker({ backgrounds, value, onChange, loading = false }: {
  backgrounds: GameplayBackground[];
  value: string;
  onChange: (value: string) => void;
  loading?: boolean;
}) {
  const group = useId();
  const options: GameplayBackground[] = [{ id: "", label: "Auto", thumbnailUrl: null }, ...backgrounds];
  const missing = value !== "" && !backgrounds.some(item => item.id === value);
  return <fieldset className="min-w-0">
    <legend className="mb-2 text-[13px] font-medium">Gameplay footage</legend>
    <div className="grid max-h-[32rem] grid-cols-2 gap-2 overflow-y-auto p-1 sm:grid-cols-3 lg:grid-cols-5">
      {options.map(option => <label key={option.id} className="relative min-w-0 cursor-pointer">
        <input type="radio" className="peer sr-only" name={group} aria-label={option.label} value={option.id} checked={value === option.id}
          onChange={() => onChange(option.id)} />
        <div className={cn("overflow-hidden rounded-xl bg-muted/50 transition-shadow peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-card",
          value === option.id ? "ring-2 ring-foreground" : "ring-1 ring-border hover:ring-muted-foreground")}>
          <div className="relative aspect-[9/16] overflow-hidden bg-muted">
            {option.id === "" ? <div className="flex h-full flex-col items-center justify-center gap-3 px-2 text-center">
              <Shuffle className="size-7 text-muted-foreground" aria-hidden="true" />
              <span className="text-xs text-muted-foreground">Choose for me</span>
            </div> : <GameplayThumbnail key={option.thumbnailUrl ?? option.id} url={option.thumbnailUrl} />}
            {value === option.id && <span aria-hidden="true" className="absolute top-2 right-2 grid size-5 place-items-center rounded-full bg-primary text-primary-foreground shadow-sm"><Check className="size-3.5" /></span>}
          </div>
          <span className="block min-h-12 px-2 py-2.5 text-center text-xs font-medium leading-snug">{option.label}</span>
        </div>
      </label>)}
    </div>
    {loading && <p role="status" className="mt-2 text-xs text-muted-foreground">Loading footage…</p>}
    {!loading && backgrounds.length === 0 && <p className="mt-2 text-xs text-muted-foreground">Auto lets the worker choose from its available footage.</p>}
    {missing && <p role="alert" className="mt-2 text-xs text-destructive">That footage is no longer available. Choose Auto or another clip.</p>}
  </fieldset>;
}

function GameplayThumbnail({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) return <div className="flex h-full flex-col items-center justify-center gap-2 px-2 text-center text-muted-foreground">
    <ImageOff aria-hidden="true" className="size-5" /><span className="text-xs">Preview unavailable</span>
  </div>;
  return <img src={url} alt="" width={272} height={484} loading="lazy" decoding="async"
    className="h-full w-full object-contain" onError={() => setFailed(true)} />;
}
