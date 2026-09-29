import { VentureMark } from "@/components/VentureChrome";
import { useStore } from "@/lib/store";

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

export function HostMark({ host, size = 14, className }: { host: string | null | undefined; size?: number; className?: string }) {
  const { state } = useStore();
  const key = hostKey(host);
  if (!key) return null;
  const venture =
    state.ventures.find((v) => v.host && v.host.toLowerCase() === key) ??
    state.ventures.find((v) => v.host && key.endsWith(`.${v.host.toLowerCase()}`));
  return venture ? <VentureMark venture={venture} size={size} className={className} /> : null;
}
