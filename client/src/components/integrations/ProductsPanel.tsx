import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { integrations } from "@/lib/api/integrations";
import { cn } from "@/lib/utils";
import { ago, count } from "./format";
import { EntityLinks } from "./EntityLinks";
import { Note, PanelEmpty, PanelSection, Row, Rows, Tiles } from "./Panel";

/**
 * THE PRODUCTS' OWN NUMBERS, asked of the products themselves.
 *
 * One account is one endpoint that returns JSON; the METRICS setting says
 * which numbers inside that JSON matter, as “label = path.to.the.number”. So
 * this is the one integration whose figures the owner named, which has two
 * consequences the panel is built around:
 *
 *   A PATH THAT MATCHES NOTHING IS AN ERROR WITH A NAME, never a zero. The
 *   server gathers every one of them into `mappingErrors` with the keys the
 *   document actually has, and they are printed at the top rather than left as
 *   an em dash on a row somebody would read as "quiet today".
 *
 *   NOTHING IS ADDED ACROSS ENDPOINTS. Two products' “renders” share a word
 *   the owner chose and nothing else, so there is no total here and
 *   `summary.combined` is null with that sentence on it.
 *
 * REACHABLE IS THREE-VALUED. Null is an endpoint that has never been
 * collected, which is not the same as one that is refusing.
 */
export function ProductsPanel({ onCollected }: { onCollected?: () => void }) {
  const report = useApi(() => integrations.products(), []);
  const map = useApi(() => integrations.ventureMap(), []);
  const [collecting, setCollecting] = useState(false);

  async function collect() {
    setCollecting(true);
    try {
      await api.collect("product-stats");
      report.reload();
      onCollected?.();
    } finally {
      setCollecting(false);
    }
  }

  if (report.error || !report.data) return null;
  const d = report.data;

  if (!d.endpoints.length)
    return (
      <PanelEmpty>
        No endpoint is connected. Add one above as the URL of something that
        returns JSON, then say which numbers in it matter in Settings.
      </PanelEmpty>
    );

  const s = d.summary;

  return (
    <PanelSection
      title="What it reads"
      meta={`fetched ${ago(s.lastFetchedAt)}`}
      onCollect={() => void collect()}
      collecting={collecting}
    >
      <Tiles
        items={[
          { v: `${s.reachable}/${s.configured}`, k: "endpoints answering" },
          { v: String(s.failing), k: "refusing" },
          { v: String(s.neverCollected), k: "never collected" },
          { v: String(s.metrics), k: s.metrics === 1 ? "metric mapped" : "metrics mapped" },
        ]}
      />

      {!!d.mappingErrors.length && (
        <div className="border-destructive/40 mb-4 rounded-[14px] border px-3.5 py-3">
          <div className="text-destructive mb-1.5 text-[13.5px] font-medium">
            {d.mappingErrors.length} mapping
            {d.mappingErrors.length === 1 ? "" : "s"} matched nothing
          </div>
          <div className="flex flex-col gap-1">
            {d.mappingErrors.map((e, i) => (
              <div key={`${e.endpoint}:${e.label}:${i}`} className="text-[13px]">
                <span className="font-mono">{e.endpoint}</span> ·{" "}
                <span className="font-mono">{e.path}</span>{" "}
                <span className="text-muted-foreground">{e.why}</span>
              </div>
            ))}
          </div>
          <Note>
            A path that matches nothing is reported here and never recorded as a
            zero. Fix the mapping in Settings above.
          </Note>
        </div>
      )}

      <Rows>
        {d.endpoints.map((e, i) => (
          <Row key={e.accountId} first={i === 0}>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  e.reachable === true
                    ? "bg-ok"
                    : e.reachable === false
                      ? "bg-destructive"
                      : "bg-border",
                )}
              />
              <span className="text-[14px] font-medium">{e.label}</span>
              <span className="text-muted-foreground min-w-0 truncate font-mono text-[12.5px]">
                {e.url ?? "URL not cached until the first collection"}
              </span>
              {e.status !== null && (
                <Badge variant="secondary" className="font-mono font-normal">
                  {e.status}
                </Badge>
              )}
              <span className="text-muted-foreground ml-auto shrink-0 text-[12.5px] tabular-nums">
                {e.ms === null ? "—" : `${e.ms} ms`} · {ago(e.lastFetchedAt)}
              </span>
            </div>

            {e.error && (
              <p className="text-destructive mt-1 text-[12.5px]">{e.error}</p>
            )}
            {e.reachable === null && !e.error && (
              <p className="text-muted-foreground mt-1 text-[13px]">
                Never collected. That is not a failure — nothing has asked yet.
              </p>
            )}

            {!!e.metrics.length && (
              <div className="mt-1.5 flex flex-col gap-0.5">
                {e.metrics.map((m) => (
                  <div
                    key={`${m.label}:${m.path}`}
                    className="flex flex-wrap items-baseline gap-2 text-[13px]"
                  >
                    <span className="text-muted-foreground">{m.label}</span>
                    <span className="tabular-nums">
                      {m.value === null ? "—" : count(m.value)}
                    </span>
                    {m.error && (
                      <span className="text-destructive text-[12.5px]">{m.error}</span>
                    )}
                    <code className="text-muted-foreground ml-auto truncate font-mono text-[12px]">
                      {m.path}
                      {m.scope === "all endpoints" ? "" : ` · ${m.scope} only`}
                    </code>
                  </div>
                ))}
              </div>
            )}

            {!e.metrics.length && !!e.keys?.length && (
              <p className="text-muted-foreground mt-1.5 truncate font-mono text-[12.5px]">
                No metric mapped. The document's own keys: {e.keys.join(", ")}
              </p>
            )}
            {e.truncated && (
              <p className="text-muted-foreground mt-1 text-[12.5px]">
                The document was truncated before it was stored, so a path deep
                inside it may not resolve.
              </p>
            )}

            <EntityLinks
              map={map.data}
              plugin="product-stats"
              entity={String(e.accountId)}
              label={e.label}
              onLinked={() => map.reload()}
            />
          </Row>
        ))}
      </Rows>

      <Note>{s.note}</Note>
    </PanelSection>
  );
}
