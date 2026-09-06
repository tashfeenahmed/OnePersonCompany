import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { integrations } from "@/lib/api/integrations";
import { ago, count } from "./format";
import { EntityLinks } from "./EntityLinks";
import { Note, PanelEmpty, PanelSection, Row, Rows, Tiles } from "./Panel";

/**
 * DOWNLOADS, AND NEVER INSTALLS.
 *
 * Every figure here is a count of file requests to PyPI's CDN. A CI job, a
 * container build and a person are one each, and the same laptop pulling the
 * same wheel twice today is two. Calling them installs — which is what every
 * badge on every README does — would turn a build pipeline into an audience.
 *
 * MIRRORS ARE EXCLUDED, which makes these numbers SMALLER than pypistats' own
 * default view. A mirror warming its cache is not demand, and the difference
 * is worth being surprised by once rather than quietly carrying for ever.
 *
 * A PARTIAL WEEK IS MARKED AND MUST NOT BE COMPARED. pypistats rebuilds its
 * dataset daily and the last day or two are usually absent rather than zero,
 * so the current week is always short and is labelled rather than plotted
 * beside finished ones as a collapse.
 */
export function PypiPanel({ onCollected }: { onCollected?: () => void }) {
  const report = useApi(() => integrations.pypi(), []);
  const map = useApi(() => integrations.ventureMap(), []);
  const [collecting, setCollecting] = useState(false);

  async function collect() {
    setCollecting(true);
    try {
      await api.collect("pypi");
      report.reload();
      onCollected?.();
    } finally {
      setCollecting(false);
    }
  }

  if (report.error || !report.data) return null;
  const d = report.data;

  if (!d.packages.length)
    return (
      <PanelEmpty>
        No packages are set, so there is nothing to ask pypistats about. Add
        them in Settings above — the list is the whole configuration this
        integration has.
      </PanelEmpty>
    );

  return (
    <PanelSection
      title="What it reads"
      meta={`${d.summary.answering} of ${d.summary.configured} answering · read ${ago(d.summary.seenAt)}`}
      onCollect={() => void collect()}
      collecting={collecting}
    >
      <Tiles
        items={[
          { v: count(d.summary.last30), k: "downloads, last 30 days" },
          {
            v: count(d.summary.lastCompleteWeek?.downloads ?? null),
            k: d.summary.lastCompleteWeek
              ? `last complete week (${d.summary.lastCompleteWeek.week})`
              : "no complete week held yet",
          },
          { v: count(d.summary.total), k: "over the whole history held" },
          {
            v: String(d.summary.failing),
            k: d.summary.failing === 1 ? "package failing" : "packages failing",
          },
        ]}
      />

      <Rows>
        {d.packages.map((p, i) => (
          <Row key={p.package} first={i === 0}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-[13px] font-medium">{p.package}</span>
              {p.version && (
                <Badge variant="secondary" className="font-mono font-normal">
                  {p.version}
                </Badge>
              )}
              <span className="text-muted-foreground ml-auto text-[11.5px]">
                read {ago(p.lastOkAt)}
              </span>
            </div>
            {p.summary && (
              <p className="text-muted-foreground mt-0.5 truncate text-[12px]">
                {p.summary}
              </p>
            )}
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] tabular-nums">
              <span>{count(p.last30)} in 30 days</span>
              <span className="text-muted-foreground">
                {count(p.lastCompleteWeek?.downloads ?? null)} last complete week
              </span>
              {p.currentWeek && (
                <span className="text-muted-foreground">
                  {count(p.currentWeek.downloads)} this week so far — partial, not
                  comparable
                </span>
              )}
              <span className="text-muted-foreground">
                pypistats' own rolling month: {count(p.recent.lastMonth)}
              </span>
            </div>
            {p.lastError && (
              <p className="text-destructive mt-1 text-[11.5px]">{p.lastError}</p>
            )}
            <EntityLinks
              map={map.data}
              plugin="pypi"
              entity={p.entity}
              label={p.package}
              onLinked={() => map.reload()}
            />
          </Row>
        ))}
      </Rows>

      <Note>
        {d.notes.counts} {d.notes.mirrors}
      </Note>
      <Note>
        {d.notes.recent} {d.notes.lag}
      </Note>
    </PanelSection>
  );
}
