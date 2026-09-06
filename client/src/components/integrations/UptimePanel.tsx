import { useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { integrations } from "@/lib/api/integrations";
import { cn } from "@/lib/utils";
import { ago, count, pct } from "./format";
import { EntityLinks } from "./EntityLinks";
import { Note, PanelEmpty, PanelSection, Row, Rows, Suggest, Tiles } from "./Panel";

/**
 * IS IT UP, FROM HERE — and "from here" is the whole caveat.
 *
 * Every check is one request made by THIS MACHINE over its own connection,
 * about every thirty minutes. That means three things this panel says out
 * loud rather than letting a green 100% imply otherwise: an outage shorter
 * than the gap between checks is invisible; a laptop asleep from midnight to
 * eight is eight hours nobody asked about; and a percentage over a handful of
 * checks is not worth quoting, so the server marks those and the row prints
 * the marking instead of a confident figure.
 *
 * TLS DAYS ARE A RUNWAY AND CAN GO NEGATIVE. A certificate that expired
 * yesterday is -1 days, not 0 and not missing — the sign is the alarm.
 *
 * SUGGEST FROM VENTURES exists because the list is the entire configuration
 * here and typing it twice is how a domain ends up unwatched. It reads the
 * ventures' own hosts and the Cloudflare zones already collected on this box,
 * offers the ones that are not already in the list, and WRITES NOTHING until
 * the button is pressed a second time — a settings field that filled itself
 * from a guess would be a monitor nobody chose.
 */
export function UptimePanel({ onCollected }: { onCollected?: () => void }) {
  const report = useApi(() => integrations.uptime(24), []);
  const map = useApi(() => integrations.ventureMap(), []);
  const config = useApi(() => api.pluginConfig("uptime"), []);
  const [collecting, setCollecting] = useState(false);
  const [suggested, setSuggested] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function collect() {
    setCollecting(true);
    try {
      await api.collect("uptime");
      report.reload();
      onCollected?.();
    } finally {
      setCollecting(false);
    }
  }

  /** Ask the two places this box already knows hostnames, and keep the ones
   *  not being checked. Nothing is stored by this step. */
  async function suggest() {
    setBusy(true);
    setProblem(null);
    try {
      const [ventures, cloudflare] = await Promise.all([
        api.ventures.list().catch(() => null),
        api.cloudflare(1).catch(() => null),
      ]);
      const known = new Set(
        (report.data?.hosts ?? []).map((h) => h.host.toLowerCase()),
      );
      const found = new Set<string>();
      for (const v of ventures?.ventures ?? []) if (v.host) found.add(v.host.toLowerCase());
      for (const z of cloudflare?.zones ?? []) if (z.name) found.add(z.name.toLowerCase());
      setSuggested([...found].filter((h) => !known.has(h)).sort());
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  /** Append them to the setting the form above edits, then collect — the point
   *  of adding a host is to see whether it is up. */
  async function addSuggested() {
    if (!suggested?.length) return;
    setBusy(true);
    setProblem(null);
    try {
      const current = (config.data?.config.hosts ?? "").trim();
      const next = [current, ...suggested].filter(Boolean).join("\n");
      await api.savePluginConfig("uptime", { hosts: next });
      setSuggested(null);
      config.reload();
      report.reload();
      onCollected?.();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (report.error || !report.data) return null;
  const d = report.data;

  if (!d.hosts.length)
    return (
      <PanelEmpty>
        No hosts are set, so nothing is being checked. Add them in Settings
        above — an uptime check is a request any stranger could make, which is
        exactly what makes it worth making and why there is no key here.
      </PanelEmpty>
    );

  const s = d.summary;

  return (
    <PanelSection
      title="What it reads"
      meta={`checked ${ago(s.lastCheckedAt)}`}
      onCollect={() => void collect()}
      collecting={collecting}
    >
      <Tiles
        items={[
          { v: `${s.up}/${s.configured}`, k: "up right now" },
          { v: String(s.down), k: "down right now" },
          {
            v: s.soonestTlsExpiry === null ? "—" : `${s.soonestTlsExpiry}d`,
            k: "soonest certificate expiry",
            title: "Negative means the certificate has already expired.",
          },
          { v: String(s.unknown), k: "never checked" },
        ]}
      />

      <Rows>
        {d.hosts.map((h, i) => {
          const av = h.availability.window;
          const tls = h.tls;
          return (
            <Row key={h.host} first={i === 0}>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    h.current === null
                      ? "bg-border"
                      : h.current.ok
                        ? "bg-ok"
                        : "bg-destructive",
                  )}
                />
                <a
                  href={h.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[13px] font-medium hover:underline"
                >
                  {h.host}
                </a>
                {h.current && (
                  <Badge variant="secondary" className="font-mono font-normal">
                    {h.current.status ?? h.current.error ?? "no answer"}
                  </Badge>
                )}
                {tls.daysLeft !== null && tls.daysLeft < 21 && (
                  <Badge
                    variant="secondary"
                    className="text-destructive border-transparent"
                  >
                    <ShieldAlert className="size-3" strokeWidth={1.8} />
                    {tls.daysLeft < 0
                      ? `certificate expired ${-tls.daysLeft}d ago`
                      : `certificate expires in ${tls.daysLeft}d`}
                  </Badge>
                )}
                <span className="text-muted-foreground ml-auto text-[11.5px] tabular-nums">
                  {h.current?.latencyMs === null || h.current === null
                    ? "—"
                    : `${h.current.latencyMs} ms`}
                </span>
              </div>

              <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] tabular-nums">
                <span>
                  {av.enough
                    ? `${pct(av.percent === null ? null : av.percent / 100)} of ${av.checks} checks in ${av.hours}h`
                    : `${av.ok} of ${av.checks} checks ok in ${av.hours}h`}
                </span>
                <span>
                  p50 {count(h.latency.p50)} ms · p95 {count(h.latency.p95)} ms over{" "}
                  {h.latency.samples} successful
                </span>
                <span>
                  {tls.daysLeft === null
                    ? (tls.note ?? "no certificate read")
                    : `certificate ${tls.daysLeft}d left`}
                </span>
                {h.redirectsToHttps !== null && (
                  <span>
                    http {h.redirectsToHttps ? "redirects to https" : "does NOT redirect"}
                  </span>
                )}
              </div>

              {!!h.incidents.length && (
                <p className="text-destructive mt-1 text-[11.5px]">
                  {h.incidents.length} incident{h.incidents.length === 1 ? "" : "s"} in
                  this window — latest{" "}
                  {h.incidents.at(-1)!.error ??
                    `HTTP ${h.incidents.at(-1)!.status ?? "?"}`}
                  {h.incidents.at(-1)!.ongoing ? ", still open" : ""}
                </p>
              )}
              {h.note && (
                <p className="text-muted-foreground mt-1 text-[11.5px]">{h.note}</p>
              )}

              <EntityLinks
                map={map.data}
                plugin="uptime"
                entity={h.host}
                label={h.host}
                onLinked={() => map.reload()}
              />
            </Row>
          );
        })}
      </Rows>

      <Suggest
        items={suggested}
        onSuggest={() => void suggest()}
        onAdd={() => void addSuggested()}
        busy={busy}
        noun="host"
        nothing="Nothing to add — every venture host and Cloudflare zone this box knows about is already on the list."
        note="Cloudflare offers every zone on the account, parked domains included. Add them and trim the field above, or type the ones you want."
        problem={problem}
      />

      <Note>
        {d.window.cadence}, {d.window.checkedFrom}. An outage shorter than the
        gap between checks is invisible to every figure above, and a percentage
        over a handful of checks is marked rather than quoted.
      </Note>
    </PanelSection>
  );
}
