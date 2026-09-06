import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { integrations, type PresenceStatus } from "@/lib/api/integrations";
import { cn } from "@/lib/utils";
import { ago } from "./format";
import { EntityLinks } from "./EntityLinks";
import { Note, PanelEmpty, PanelSection, Rows, Row, Suggest, Tiles } from "./Panel";
/* The owner's own ledger, under the probes that feed it. Detection may ratchet
   a row forward to `detected` and can never move one back; everything past
   that means a person looked. See integrations/seoops/listings.ts. */
import { ListingsPanel } from "@/areas/seoops/ListingsPanel";

/** The five states a cell can be in, and the colour each earns. `blocked` is
 *  deliberately NOT the same grey as `absent`: one is a fact and the other is
 *  a question nobody could ask. NULL IS A SIXTH STATE ONLY IN THAT IT IS THE
 *  ABSENCE OF ONE — this source has never been asked about this product, which
 *  is not the same as having been asked and refused. */
function cellClass(status: PresenceStatus | null): string {
  if (status === null) return "text-muted-foreground border-dotted opacity-70";
  if (status === "present") return "bg-ok-bg text-ok border-transparent";
  if (status === "blocked") return "border-dashed";
  if (status === "error") return "text-destructive border-transparent";
  return "text-muted-foreground";
}

function cellLabel(status: PresenceStatus | null): string {
  if (status === null) return "never checked";
  if (status === "present") return "listed";
  if (status === "blocked") return "not checked";
  if (status === "error") return "error";
  return "not found";
}

/**
 * WHERE THESE PRODUCTS EXIST ON SOMEBODY ELSE'S SITE — a matrix of product ×
 * source, and one distinction it is built entirely around.
 *
 * `BLOCKED` IS NOT `ABSENT`. Blocked means the source could not be asked: a
 * 403 from a WAF, a rate limit, a timeout, or a software directory whose
 * urls carry a numeric id that cannot be derived from a name and which
 * publishes no keyless lookup. Reporting a product as unlisted because a
 * firewall answered is the single worst mistake available on this page, so
 * blocked cells are drawn dashed, labelled "not checked", and counted in their
 * own column.
 *
 * `PRESENT` MEANS THE RECORD NAMED THE BRAND AND POINTED BACK. Half these
 * names are two ordinary English words and strangers own projects with the
 * same ones — so a repository sharing a product's name, whose homepage is not
 * that product's site, is filed as a CANDIDATE on an absent row, listed
 * separately for the owner to judge. Nothing here is a submission and nothing counts as done.
 *
 * THERE IS NO FOOTPRINT SCORE. The original collector's score was mostly a
 * search sweep this port does not carry, and a score built from what is left
 * would be a different number wearing the same name.
 */
export function PresencePanel({ onCollected }: { onCollected?: () => void }) {
  const report = useApi(() => integrations.presence(), []);
  const map = useApi(() => integrations.ventureMap(), []);
  const config = useApi(() => api.pluginConfig("presence"), []);
  const [collecting, setCollecting] = useState(false);
  const [suggested, setSuggested] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function collect() {
    setCollecting(true);
    try {
      await api.collect("presence");
      report.reload();
      onCollected?.();
    } finally {
      setCollecting(false);
    }
  }

  /** A venture is `Name = host` already — which is exactly the line format
   *  this setting takes, and the reason both halves are required. */
  async function suggest() {
    setBusy(true);
    setProblem(null);
    try {
      const ventures = await api.ventures.list();
      const known = new Set((report.data?.products ?? []).map((p) => p.host.toLowerCase()));
      setSuggested(
        ventures.ventures
          .filter((v) => v.host && !known.has(v.host.toLowerCase()))
          .map((v) => `${v.name} = ${v.host}`),
      );
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addSuggested() {
    if (!suggested?.length) return;
    setBusy(true);
    setProblem(null);
    try {
      const current = (config.data?.config.products ?? "").trim();
      await api.savePluginConfig("presence", {
        products: [current, ...suggested].filter(Boolean).join("\n"),
      });
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

  if (!d.products.length)
    return (
      <PanelEmpty>
        No products are set. Each line is <code>Name = host</code> in Settings
        above — the name is what a directory would have called it, and the host
        is what proves a record found that way is yours.
      </PanelEmpty>
    );

  const totals = d.products.reduce(
    (acc, p) => ({
      present: acc.present + p.summary.present,
      blocked: acc.blocked + p.summary.blocked,
      candidates: acc.candidates + p.candidates.length,
    }),
    { present: 0, blocked: 0, candidates: 0 },
  );

  return (
    <PanelSection
      title="What it reads"
      meta={`checked ${ago(d.summary.checkedAt)}`}
      onCollect={() => void collect()}
      collecting={collecting}
    >
      <Tiles
        items={[
          { v: String(d.summary.configured), k: d.summary.configured === 1 ? "product" : "products" },
          { v: String(d.sources.length), k: "sources asked" },
          { v: String(totals.present), k: "listings found" },
          {
            v: String(totals.blocked),
            k: "cells not checked — never “unlisted”",
          },
        ]}
      />

      <Rows>
        {d.products.map((p, i) => (
          <Row key={p.product} first={i === 0}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[13px] font-medium">{p.product}</span>
              <span className="text-muted-foreground font-mono text-[11.5px]">
                {p.host}
              </span>
              <span className="text-muted-foreground ml-auto text-[11.5px]">
                {p.summary.present} listed · {p.summary.absent} not found ·{" "}
                {p.summary.blocked} not checked · {ago(p.checkedAt)}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {p.sources.map((src) => {
                const inner = (
                  <>
                    {src.label}
                    <span className="opacity-70"> {cellLabel(src.status)}</span>
                  </>
                );
                return src.url ? (
                  <a
                    key={src.source}
                    href={src.url}
                    target="_blank"
                    rel="noreferrer"
                    title={src.note ?? src.method}
                  >
                    <Badge
                      variant="outline"
                      className={cn("font-normal", cellClass(src.status))}
                    >
                      {inner}
                    </Badge>
                  </a>
                ) : (
                  <Badge
                    key={src.source}
                    variant="outline"
                    title={src.note ?? src.method}
                    className={cn("font-normal", cellClass(src.status))}
                  >
                    {inner}
                  </Badge>
                );
              })}
            </div>

            {!!p.candidates.length && (
              <div className="mt-2">
                <div className="text-muted-foreground text-[11.5px]">
                  {p.candidates.length} candidate
                  {p.candidates.length === 1 ? "" : "s"} — named the brand but did
                  not point back at {p.host}, so they are yours to judge:
                </div>
                {p.candidates.map((cand) => (
                  <a
                    key={cand.url}
                    href={cand.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-muted-foreground hover:text-foreground block truncate font-mono text-[11.5px]"
                  >
                    {cand.source} → {cand.url}
                  </a>
                ))}
              </div>
            )}

            <EntityLinks
              map={map.data}
              plugin="presence"
              entity={p.host}
              label={`${p.product} (${p.host})`}
              onLinked={() => map.reload()}
            />
          </Row>
        ))}
      </Rows>

      <Suggest
        items={suggested}
        onSuggest={() => void suggest()}
        onAdd={() => void addSuggested()}
        busy={busy}
        noun="product"
        nothing="Every venture with a website is already a product here."
        note="Each line is “Name = host”. The name is what a directory would have called it — rename one in the field above if the venture's own name is not the brand."
        problem={problem}
      />

      {d.notes.map((n) => (
        <Note key={n}>{n}</Note>
      ))}

      <ListingsPanel />
    </PanelSection>
  );
}
