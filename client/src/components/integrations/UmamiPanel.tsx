import { useState } from "react";
import { useApi } from "@/hooks/useApi";
import { api } from "@/lib/api";
import { integrations } from "@/lib/api/integrations";
import { ago, count, duration, pct } from "./format";
import { EntityLinks } from "./EntityLinks";
import { Note, PanelEmpty, PanelSection, Row, Rows, Tiles } from "./Panel";

/**
 * WHAT UMAMI COUNTED, PER WEBSITE, AND THE ONE FIGURE THERE IS NO PORTFOLIO
 * NUMBER FOR.
 *
 * Pageviews and visits add across sites: a pageview is an event on one site
 * and adding two of them is arithmetic. VISITORS DO NOT. Umami de-duplicates a
 * visitor per website over the window, so one person who read two of these
 * sites is one visitor on each and one person in the world — and no Umami
 * endpoint can join identity across websites, so there is nothing to fetch
 * either. The server ships `visitors.combined: null` with that sentence on it,
 * and this panel prints the sentence rather than the sum it would be so easy
 * to compute here and so wrong to show.
 *
 * The bounce rate is Umami's own: a visit with a single pageview. It is not
 * GA4's engaged-session figure and the two must never be put in one column.
 */
export function UmamiPanel({ onCollected }: { onCollected?: () => void }) {
  const report = useApi(() => integrations.umami(), []);
  const map = useApi(() => integrations.ventureMap(), []);
  const [collecting, setCollecting] = useState(false);

  async function collect() {
    setCollecting(true);
    try {
      await api.collect("umami");
      report.reload();
      onCollected?.();
    } finally {
      setCollecting(false);
    }
  }

  if (report.error || !report.data) return null;
  const d = report.data;

  if (!d.websites.length)
    return (
      <PanelEmpty>
        Connected, but the last collection found no websites on this instance.
        Umami lists what the account can see — a fresh instance with no site
        added yet reads exactly like this.
      </PanelEmpty>
    );

  const w = d.portfolio.window;

  return (
    <PanelSection
      title="What it reads"
      meta={`${d.portfolio.answering} of ${d.portfolio.websites} answering`}
      onCollect={() => void collect()}
      collecting={collecting}
    >
      <Tiles
        items={[
          { v: count(w.pageviews), k: `pageviews, ${w.days} days` },
          { v: count(w.visits), k: "visits" },
          /* The server scales this one to 0–100; `pct` takes a fraction, and the
             division is here rather than hidden inside an import. */
          { v: pct(w.bounceRate === null ? null : w.bounceRate / 100), k: "bounce rate" },
          { v: duration(w.avgVisitSeconds), k: "average visit" },
        ]}
      />

      <Rows>
        {d.websites.map((site, i) => (
          <Row key={`${site.accountId}:${site.entity}`} first={i === 0}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-[14px] font-medium">{site.name}</span>
              <span className="text-muted-foreground font-mono text-[12.5px]">
                {site.domain ?? "no domain recorded"}
              </span>
              <span className="text-muted-foreground ml-auto text-[12.5px]">
                {site.account} · read {ago(site.seenAt)}
              </span>
            </div>
            {site.window ? (
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[13px] tabular-nums">
                <span>{count(site.window.pageviews)} pageviews</span>
                <span>{count(site.window.visitors)} visitors</span>
                <span>{count(site.window.visits)} visits</span>
                <span className="text-muted-foreground">
                  {pct(site.window.bounceRate === null ? null : site.window.bounceRate / 100)} bounce ·{" "}
                  {duration(site.window.avgVisitSeconds)} average visit
                </span>
              </div>
            ) : (
              <p className="text-muted-foreground mt-1 text-[13px]">
                No window collected for this site yet — it is listed on the
                instance and has not been read.
              </p>
            )}
            <EntityLinks
              map={map.data}
              plugin="umami"
              entity={site.entity}
              label={site.name}
              onLinked={() => map.reload()}
            />
          </Row>
        ))}
      </Rows>

      <Note>
        <b className="text-foreground font-medium">
          There is no portfolio visitor count, and there cannot be one.
        </b>{" "}
        {d.portfolio.visitors.note} Per site over this window:{" "}
        {d.portfolio.visitors.perSite
          .map((s) => `${s.domain ?? s.entity} ${count(s.visitors)}`)
          .join(" · ") || "nothing read yet"}
        .
      </Note>
      <Note>
        {d.notes.window} {d.notes.bounce}
      </Note>
    </PanelSection>
  );
}
