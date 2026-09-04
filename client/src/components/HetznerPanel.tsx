import { RefreshCw, ServerIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";

const eur = (n: number) =>
  new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(n);

function ago(iso: string | null) {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * What the last collection actually found.
 *
 * Reads the database rather than Hetzner, so opening this page does not depend
 * on Hetzner being up — the freshness line says how old the answer is instead
 * of the page failing to load.
 */
export function HetznerPanel({ onCollected }: { onCollected?: () => void }) {
  const summary = useApi(() => api.hetznerSummary(), []);
  const fleet = useApi(() => api.hetznerServers(), []);

  async function collectNow() {
    await api.collect("hetzner");
    summary.reload();
    fleet.reload();
    onCollected?.();
  }

  if (summary.error) return null;
  const s = summary.data;
  if (!s) return null;

  if (!s.servers && !s.volumes) {
    return (
      <>
        <Separator className="mt-7 mb-5" />
        <p className="text-muted-foreground text-[13px]">
          Connected, but the last collection found no servers on{" "}
          {s.accounts.length > 1 ? "any of these accounts" : "this account"}.
        </p>
      </>
    );
  }

  // Once there are two, every figure below is a sum and the page says which
  // accounts it is the sum of — rather than presenting two projects' bill as
  // if it came off one console.
  const multi = s.accounts.length > 1;

  return (
    <>
      <Separator className="mt-7 mb-5" />
      <div className="mb-3 flex items-center gap-2">
        <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
          What it reads
        </div>
        <span className="text-muted-foreground ml-auto text-[11.5px]">
          collected {ago(s.seenAt)}
        </span>
        <Button variant="outline" size="sm" onClick={collectNow}>
          <RefreshCw className="size-3.5" strokeWidth={1.8} />
          Collect now
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {[
          [eur(s.monthlyEur), "per month, net of VAT"],
          [`${s.running}/${s.servers}`, "servers running"],
          [String(s.volumes), s.volumes === 1 ? "volume" : "volumes"],
          [
            Object.keys(s.byLocation).join(", ") || "—",
            Object.keys(s.byLocation).length === 1 ? "location" : "locations",
          ],
          ...(multi
            ? ([[String(s.accounts.length), "accounts, summed"]] as const)
            : []),
        ].map(([v, k]) => (
          <div
            key={k}
            className="bg-card min-w-[132px] flex-1 rounded-[10px] border px-3.5 py-3"
          >
            <div className="text-[19px] font-normal tracking-[-0.03em] tabular-nums">
              {v}
            </div>
            <div className="text-muted-foreground mt-0.5 text-[11.5px]">
              {k}
            </div>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-[10px] border">
        {(fleet.data?.servers ?? []).map((srv, i) => (
          <div
            key={srv.id}
            className={cn(
              "flex items-center gap-3 px-3.5 py-2.5",
              i > 0 && "border-line-soft border-t",
            )}
          >
            <ServerIcon
              className={cn(
                "size-4 shrink-0",
                srv.status === "running" ? "text-ok" : "text-muted-foreground",
              )}
              strokeWidth={1.6}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{srv.name}</div>
              <div className="text-muted-foreground truncate font-mono text-[11.5px]">
                {[srv.ipv4, srv.specs].filter(Boolean).join(" · ")}
              </div>
            </div>
            {multi && (
              <Badge variant="secondary" className="hidden sm:inline-flex">
                {srv.accountLabel}
              </Badge>
            )}
            <Badge variant="secondary" className="hidden sm:inline-flex">
              {srv.location}
            </Badge>
            <Badge
              variant="secondary"
              className="hidden font-mono font-normal md:inline-flex"
            >
              {srv.plan}
            </Badge>
            <div className="w-[92px] shrink-0 text-right text-[12.5px] tabular-nums">
              {srv.monthlyEur === null ? (
                <span className="text-muted-foreground">unpriced</span>
              ) : (
                eur(srv.monthlyEur + (srv.ipv4MonthlyEur ?? 0))
              )}
            </div>
          </div>
        ))}
      </div>

      <p className="text-muted-foreground mt-2.5 text-[11.5px]">
        {multi && (
          <>
            {s.accounts
              .map((a) => `${a.label} ${eur(a.monthlyEur)}`)
              .join(" · ")}
            .{" "}
          </>
        )}
        Servers {eur(s.serverMonthlyEur)} · volumes {eur(s.volumeMonthlyEur)}.
        Prices are Hetzner's current rate for each plan at its own location, net
        of VAT — the vendor's price, not an invoice.
      </p>
    </>
  );
}
