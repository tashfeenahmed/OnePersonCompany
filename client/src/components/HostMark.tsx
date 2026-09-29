import { VentureMark } from "@/components/VentureChrome";
import { useStore } from "@/lib/store";

/**
 * A HOSTNAME'S VENTURE FAVICON — "example.com", "https://www.example.org/",
 * "sc-domain:example.net" all find their venture. A subdomain finds its
 * parent's venture ("blog.x.com" → x.com). A host that belongs to no venture
 * draws nothing rather than a guessed icon.
 */
export function hostKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.replace(/^sc-domain:/i, "");
  try {
    const url = new URL(v.includes("://") ? v : `https://${v}`);
    return url.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function HostMark({
  host,
  size = 14,
  className,
  fallback = false,
}: {
  host: string | null | undefined;
  size?: number;
  className?: string;
  /** Draw the host's first letter when no venture owns it, for a place
   *  where an empty gap would misalign a grid of cards. */
  fallback?: boolean;
}) {
  const { state } = useStore();
  const key = hostKey(host);
  if (!key) return null;
  const venture =
    state.ventures.find((v) => v.host && v.host.toLowerCase() === key) ??
    state.ventures.find((v) => v.host && key.endsWith(`.${v.host.toLowerCase()}`));
  if (venture) return <VentureMark venture={venture} size={size} className={className} />;
  if (!fallback) return null;
  return (
    <span
      aria-hidden
      className={`bg-muted text-muted-foreground inline-flex shrink-0 items-center justify-center font-medium uppercase ${className ?? ""}`}
      style={{ width: size, height: size, borderRadius: size * 0.225, fontSize: size * 0.5 }}
    >
      {key.slice(0, 1)}
    </span>
  );
}
