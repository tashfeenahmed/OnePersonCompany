import { VentureMark } from "@/components/VentureChrome";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * A HOSTNAME'S VENTURE FAVICON — "freellmapi.co", "https://www.livetutor.io/",
 * "sc-domain:planintel.ie" all find their venture. A subdomain finds its
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
  /** In a list, a host with no venture gets a quiet initial in the favicon's
   *  place, so the names still line up. A monogram, not a guessed icon. */
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
      className={cn(
        "bg-muted text-muted-foreground inline-grid shrink-0 place-items-center rounded-[4px] font-medium uppercase",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.62), lineHeight: 1 }}
    >
      {key.charAt(0)}
    </span>
  );
}
