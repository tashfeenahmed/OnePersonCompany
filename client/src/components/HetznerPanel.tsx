import { RefreshCw, ServerIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api";
import { Tiles } from "@/components/integrations/Panel";
import { DASH, ago, money } from "@/lib/format";
import { cn } from "@/lib/utils";

/** This provider bills in euro whoever is reading the page. */
const eur = (n: number) => money(n, "EUR");

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

      <Tiles
        items={[
          { v: eur(s.monthlyEur), k: "per month, net of VAT" },
          { v: `${s.running}/${s.servers}`, k: "servers running" },
          { v: s.volumes, k: s.volumes === 1 ? "volume" : "volumes" },
          {
            /* A list of place names, not a figure — so it truncates to one
               line and carries the whole list in its title. */
            v: Object.keys(s.byLocation).join(", ") || DASH,
            k: Object.keys(s.byLocation).length === 1 ? "location" : "locations",
            title: Object.keys(s.byLocation).join(", "),
            text: true,
          },
          ...(multi ? [{ v: s.accounts.length, k: "accounts, summed" }] : []),
        ]}
      />

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
