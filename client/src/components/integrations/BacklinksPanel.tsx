import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { integrations } from "@/lib/api/integrations";
import { cn } from "@/lib/utils";
import { ago, count } from "./format";
import { EntityLinks } from "./EntityLinks";
import { Note, PanelEmpty, PanelSection, Row, Rows, Suggest, Tiles } from "./Panel";

/**
 * WHO LINKS HERE — ACCORDING TO WHOM.
 *
 * THREE SOURCES, THREE ROWS, AND NEVER A TOTAL. Common Crawl, Bing Webmaster
 * and a verification crawler that goes and looks. They overlap, they disagree
 * by design, and adding two of them counts a host twice — so every figure on
 * this panel is drawn on the row of the source that said it, with that
 * source's confidence beside it, and `referringDomains.combined` prints as the
 * server's refusal rather than a sum.
 *
 * `ok: false` IS A SOURCE THAT REFUSED. `ok: null` is one that was never asked
 * — no Bing account connected, no index resolved. And a 0 with `ok: true` is a
 * real measurement of nothing, which this panel draws as 0 and not as a gap.
 * Those three states are the whole reason the row is a row and not a number.
 *
 * HOST IN-DEGREE IS NOT MEASURED and nothing here is a proxy for it. Common
 * Crawl's hyperlink graph is the only free source and it has no query
 * endpoint; what it contributes is crawl presence — pages of the domain its
 * index captured — which is a different thing wearing a similar word.
 */
export function BacklinksPanel({ onCollected }: { onCollected?: () => void }) {
  const report = useApi(() => integrations.backlinks(), []);
  const map = useApi(() => integrations.ventureMap(), []);
  const config = useApi(() => api.pluginConfig("backlinks"), []);
  const [collecting, setCollecting] = useState(false);
  const [suggested, setSuggested] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function collect() {
    setCollecting(true);
    try {
      await api.collect("backlinks");
      report.reload();
      onCollected?.();
    } finally {
      setCollecting(false);
    }
  }

  async function suggest() {
    setBusy(true);
    setProblem(null);
    try {
      const ventures = await api.ventures.list();
      const known = new Set((report.data?.hosts ?? []).map((h) => h.host.toLowerCase()));
      setSuggested(
        ventures.ventures
          .map((v) => v.host?.toLowerCase())
          .filter((h): h is string => !!h && !known.has(h))
          .filter((h, i, all) => all.indexOf(h) === i)
          .sort(),
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
      const current = (config.data?.config.hosts ?? "").trim();
      await api.savePluginConfig("backlinks", {
        hosts: [current, ...suggested].filter(Boolean).join("\n"),
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

  if (!d.hosts.length)
    return (
      <PanelEmpty>
        No sites are set, so nothing is being asked about. Add them in Settings
        above — every source here is free and keyless, so a list is the whole
        configuration.
      </PanelEmpty>
    );

  return (
    <PanelSection
      title="What it reads"
      meta={`${d.summary.collected} of ${d.summary.configured} collected · ${ago(d.summary.seenAt)}`}
      onCollect={() => void collect()}
      collecting={collecting}
    >
      <Tiles
        items={[
          { v: String(d.summary.configured), k: d.summary.configured === 1 ? "site watched" : "sites watched" },
          { v: String(Object.keys(d.sourceLabels).length), k: "sources, never summed" },
          { v: `${d.summary.everyHours}h`, k: "between collections, per host" },
          { v: String(d.summary.pending.length), k: "waiting for a first collection" },
        ]}
      />

      <div className="flex flex-col gap-2">
        {d.hosts.map((h) => (
          <div key={h.host} className="rounded-[10px] border p-3.5">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[13px] font-medium">{h.host}</span>
              {!h.collected && (
                <Badge variant="secondary">not collected yet</Badge>
              )}
              <span className="text-muted-foreground ml-auto text-[11.5px]">
                {h.links.length} link{h.links.length === 1 ? "" : "s"} held ·{" "}
                {ago(h.seenAt)}
              </span>
            </div>

            <div className="mt-2.5">
            <Rows>
              {h.sources.map((src, i) => (
                <Row key={src.source} first={i === 0}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        src.ok === true
                          ? "bg-ok"
                          : src.ok === false
                            ? "bg-destructive"
                            : "bg-border",
                      )}
                      title={
                        src.ok === true
                          ? "answered"
                          : src.ok === false
                            ? "refused"
                            : "never asked"
                      }
                    />
                    <span className="text-[12.5px] font-medium">{src.label}</span>
                    <Badge variant="secondary" className="font-normal">
                      confidence {src.confidence}
                    </Badge>
                    <span className="text-muted-foreground ml-auto text-[11.5px]">
                      {src.ok === null ? "never asked" : ago(src.seenAt)}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] tabular-nums">
                    <span>referring domains {count(src.referringDomains)}</span>
                    <span>inbound links {count(src.backlinks)}</span>
                    <span>linked pages {count(src.linkedPages)}</span>
                    <span>crawl presence {count(src.crawlPages)}</span>
                    {src.verified && (
                      <span>
                        verified {src.verified.checked} checked ·{" "}
                        {count(src.verified.live)} live · {count(src.verified.followed)}{" "}
                        followed
                      </span>
                    )}
                  </div>
                  {(src.note || src.error) && (
                    <p
                      className={cn(
                        "mt-1 text-[11.5px]",
                        src.error ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {src.error ?? src.note}
                    </p>
                  )}
                </Row>
              ))}
            </Rows>
            </div>

            <Note>{h.referringDomains.note}</Note>

            <EntityLinks
              map={map.data}
              plugin="backlinks"
              entity={h.host}
              label={h.host}
              onLinked={() => map.reload()}
            />
          </div>
        ))}
      </div>

      <Suggest
        items={suggested}
        onSuggest={() => void suggest()}
        onAdd={() => void addSuggested()}
        busy={busy}
        noun="site"
        nothing="Every venture with a website is already on the list."
        problem={problem}
      />

      {d.notes.map((n) => (
        <Note key={n}>{n}</Note>
      ))}
    </PanelSection>
  );
}
