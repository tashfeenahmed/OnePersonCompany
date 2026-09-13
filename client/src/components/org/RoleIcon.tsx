import { cn } from "@/lib/utils";
import { FALLBACK_ROLE_ARTWORK, ROLE_ARTWORK } from "@/components/org/roleArtwork";

// Vite fingerprints and packages both the reused clay set and the new artwork.
const artwork = import.meta.glob<string>(
  ["../../assets/modules/*.webp", "../../assets/agents/*.webp"],
  { eager: true, query: "?url&no-inline", import: "default" },
);

/** One 3D identity per role, shared by every venture and worker surface. */
export function RoleIcon({ role, className }: { role: string; className?: string }) {
  const key = Object.hasOwn(ROLE_ARTWORK, role) ? ROLE_ARTWORK[role] : FALLBACK_ROLE_ARTWORK;
  return <img
    src={artwork[`../../assets/${key}.webp`]}
    alt=""
    aria-hidden="true"
    data-role={role}
    width={28}
    height={28}
    draggable={false}
    decoding="async"
    className={cn("size-7 shrink-0 select-none object-contain", className)}
  />;
}
