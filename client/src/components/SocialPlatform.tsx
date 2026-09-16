import { Globe2 } from "lucide-react";
import { BRAND_ICONS } from "@/data/brandIcons";
import { cn } from "@/lib/utils";

const aliases: Record<string, string> = { ig: "instagram", page: "facebook", twitter: "x" };
const labels: Record<string, string> = {
  instagram: "Instagram", linkedin: "LinkedIn", x: "X", facebook: "Facebook", tiktok: "TikTok", "": "Any",
};
const marks: Record<string, string> = {
  facebook: '<path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047v-2.66c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.971h-1.513c-1.491 0-1.956.931-1.956 1.887v2.263h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073Z"/>',
  x: '<path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.64 7.584H.47l8.6-9.835L0 1.154h7.594l5.243 6.932Zm-1.29 19.49h2.039L6.487 3.24H4.3Z"/>',
};

function platformKey(platform: string) {
  const key = platform.toLowerCase();
  return aliases[key] ?? key;
}

/** Local, decorative marks; the adjacent label supplies the accessible name. */
export function SocialPlatformIcon({ platform, className }: { platform: string; className?: string }) {
  const key = platformKey(platform);
  const svg = marks[key] ?? BRAND_ICONS[key]?.svg;
  const classes = cn("size-4 shrink-0", className);
  return svg
    ? <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={classes} dangerouslySetInnerHTML={{ __html: svg }} />
    : <Globe2 aria-hidden="true" className={classes} strokeWidth={1.6} />;
}

export function SocialPlatformLabel({ platform, className }: { platform: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <SocialPlatformIcon platform={platform} />
      <span>{labels[platformKey(platform)] ?? platform}</span>
    </span>
  );
}
