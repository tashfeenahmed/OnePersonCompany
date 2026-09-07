import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { SubTabs } from "@/components/TabStrip";
import { PageShell } from "@/components/PageShell";
import { RankedBars } from "@/components/RankedBars";
import { Failed, Loading, Num, Rules, SectionCard } from "@/components/ui/state";
import { WindowPicker } from "@/components/WindowPicker";
import { useApi } from "@/hooks/useApi";
import { count, money } from "@/lib/format";
import { cn } from "@/lib/utils";
import { webAnalytics, type AdRow, type Finding, type SegmentBlock } from "./api";

/**
 * WEB ANALYTICS — four tabs, and the four things this page may never draw.
 *
 * It sits beside the Umami plugin panel rather than replacing it: that panel
 * has the headline figures and is what the dashboard's cards agree with. This
 * is the depth under them — which audience, which event, which campaign, which
 * advertisement — and the two are live at once.
 *
 * THE RULES THIS PAGE MAY NEVER BREAK, each one a way to draw a confident lie
 * out of an honest document:
 *
 *   * RAW AND ADJUSTED ARE ALWAYS BOTH ON SCREEN. The bot-diagnostics toggle
 *     changes which is emphasised and the sentence beside it; it never removes
 *     the raw figure, and there is no state of this component in which the
 *     adjusted number is the only one drawn.
 *   * NEVER DRAW A NULL AS A ZERO. A participant count that was not asked for,
 *     a fatigue verdict that could not be reached, a unit nobody stated — all
 *     of them are "—" with the server's own reason printed, never an empty bar
 *     that reads as good news.
 *   * NEVER PUT TWO POPULATIONS ON ONE AXIS. Country counts visitors and
 *     referrer counts views; every block prints which, and the remainder that
 *     no value accounted for is drawn rather than folded into the shares.
 *   * NEVER DRAW A FUNNEL. The conversion steps are independent counts and are
 *     drawn as a list of counts, never as a narrowing shape.
 */

const TABS = [
  { key: "segments", label: "Segments" },
  { key: "events", label: "Events" },
  { key: "campaigns", label: "Campaigns" },
  { key: "creatives", label: "Creatives" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function WebAnalytics() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.key === params.get("tab"))?.key ?? "segments") as TabKey;
  const site = params.get("site") ?? "";
  const days = params.get("days") === "7" ? 7 : 30;
  const bots = params.get("bots") === "1";

  const set = (next: Partial<{ tab: TabKey; site: string; days: 7 | 30; bots: boolean }>) => {
    const out: Record<string, string> = {};
    const t = next.tab ?? tab;
    const s = next.site ?? site;
    const d = next.days ?? days;
    const b = next.bots ?? bots;
    if (t !== "segments") out.tab = t;
    if (s) out.site = s;
    if (d !== 30) out.days = String(d);
    if (b) out.bots = "1";
    setParams(out);
  };

  return (
    <PageShell
      title="Web analytics"
      wide
      sub="Underneath the headline: which audience changed, what visitors actually did, which campaigns sent them, and which advertisements are wearing out. Nothing here replaces a figure on the Umami page — every raw number is still exactly what Umami counted."
    >
      <SubTabs tabs={TABS} activeKey={tab} onSelect={(k) => set({ tab: k as TabKey })} rule />

      {tab === "segments" && (
        <SegmentsTab
          site={site}
          days={days}
          bots={bots}
          onSite={(s) => set({ site: s })}
          onDays={(d) => set({ days: d })}
          onBots={(b) => set({ bots: b })}
        />
      )}
      {tab === "events" && <EventsTab site={site} onSite={(s) => set({ site: s })} />}
      {tab === "campaigns" && <CampaignsTab />}
      {tab === "creatives" && <CreativesTab />}
    </PageShell>
  );
}

/* ------------------------------------------------------------ small parts */

function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <ul className="text-muted-foreground mb-3 space-y-1 text-[12.5px]">
      {notes.map((n) => (
        <li key={n}>· {n}</li>
      ))}
    </ul>
  );
}

function SitePicker({
  site,
  onSite,
  right,
}: {
  site: string;
  onSite: (s: string) => void;
  right?: React.ReactNode;
}) {
  const sites = useApi(() => webAnalytics.sites(), []);
  if (sites.loading) return <Loading what="the website list" />;
  if (sites.error) return <Failed error={sites.error} />;
  const rows = sites.data?.sites ?? [];
  const current = site || rows.find((r) => r.readAt)?.websiteId || rows[0]?.websiteId || "";
  if (current && current !== site) queueMicrotask(() => onSite(current));
  const row = rows.find((r) => r.websiteId === current);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <select
        aria-label="Website"
        value={current}
        onChange={(e) => onSite(e.target.value)}
        className="border-line-soft bg-card rounded px-3 py-1.5 text-[13.5px]"
      >
        {rows.map((r) => (
          <option key={r.websiteId} value={r.websiteId}>
            {r.domain ?? r.name ?? r.websiteId}
            {r.readAt ? "" : " — not read yet"}
          </option>
        ))}
      </select>
      <span className="text-muted-foreground text-[12.5px]">
        {row?.readAt
          ? `read ${row.staleHours ?? 0}h ago · rotation every ${sites.data?.everyHours}h`
          : "this site has not had its turn in the rotation yet — that is not a site with no traffic"}
      </span>
      {right}
    </div>
  );
}

/* --------------------------------------------------------------- segments */

function SegmentsTab({
  site,
  days,
  bots,
  onSite,
  onDays,
  onBots,
}: {
  site: string;
  days: 7 | 30;
  bots: boolean;
  onSite: (s: string) => void;
  onDays: (d: 7 | 30) => void;
  onBots: (b: boolean) => void;
}) {
  return (
    <>
      <SitePicker
        site={site}
        onSite={onSite}
        right={
          <>
            <WindowPicker
              value={days}
              onChange={(d) => onDays(d === 7 ? 7 : 30)}
              options={[7, 30]}
              label="Window in days"
              className="ml-auto"
            />
            {/* WHICH WINDOW HAS A COMPARISON is a fact about the data, not a
                label on the control: the 7-day cut is drawn against the 7 days
                before it and the 30-day cut has nothing to compare with. */}
            <span className="text-muted-foreground text-[12.5px]">
              the 7-day window is drawn against the 7 days before it
            </span>
            <label className="flex items-center gap-1.5 text-[12.5px]">
              <input type="checkbox" checked={bots} onChange={(e) => onBots(e.target.checked)} />
              bot diagnostics
            </label>
          </>
        }
      />
      {site ? <SegmentsBody site={site} days={days} bots={bots} /> : null}
    </>
  );
}

function SegmentsBody({ site, days, bots }: { site: string; days: 7 | 30; bots: boolean }) {
  const { data, error, loading } = useApi(() => webAnalytics.segments(site, days), [site, days]);
  if (loading) return <Loading what="the segments" />;
  if (error) return <Failed error={error} />;
  if (!data) return null;

  return (
    <>
      <SectionCard
        title="Raw, and what a heuristic would take off"
        meta={data.raw.startDay ? `${data.raw.startDay} → ${data.raw.endDay}` : "no window collected"}
      >
        {/* BOTH FIGURES, ALWAYS. The toggle emphasises one; it removes neither. */}
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Figure label="visitors (raw)" value={data.raw.visitors} emphasis={!bots} />
          <Figure
            label="visitors (adjusted)"
            value={data.adjusted.visitors.value}
            emphasis={bots}
            sub={data.adjusted.visitors.heuristic ?? "no heuristic matched"}
          />
          <Figure label="pageviews" value={data.raw.pageviews} />
          <Figure label="visits" value={data.raw.visits} />
        </div>
        <p className="text-muted-foreground mt-3 text-[12.5px]">{data.adjusted.visitors.basis}</p>
        <p className="text-muted-foreground mt-1 text-[12.5px]">{data.adjusted.note}</p>
      </SectionCard>

      {bots && (
        <SectionCard
          title="Bot diagnostics"
          meta={`${data.findings.length} finding(s) from ${data.heuristics.length} heuristics`}
        >
          {data.findings.length ? (
            data.findings.map((f) => <FindingRow key={`${f.heuristic}|${f.fingerprint}`} finding={f} />)
          ) : (
            <p className="text-muted-foreground text-[13.5px]">
              No heuristic matched on this site. That is not proof there is no automated traffic — it
              is proof that none of the four tests below fired.
            </p>
          )}
          {/* A TEST THAT COULD NOT BE RUN IS NOT A TEST THAT FOUND NOTHING, and
              this block is the difference. */}
          {data.refusals.map((r) => (
            <p key={`${r.heuristic}|${r.windowDays}|${r.offsetDays}`} className="text-warn-foreground mt-2 text-[12.5px]">
              {r.heuristic} was NOT RUN over {r.windowDays} days — {r.reason}
            </p>
          ))}
          <details className="mt-3">
            <summary className="text-muted-foreground cursor-pointer text-[12.5px]">
              The rubric, and how each test can be wrong
            </summary>
            <div className="mt-2 space-y-3">
              {data.heuristics.map((h) => (
                <div key={h.id} className="text-[12.5px]">
                  <p className="font-medium">
                    {h.title}{" "}
                    <span className="text-muted-foreground font-normal">
                      · {h.id} · {h.population ?? "excludes nothing"}
                    </span>
                  </p>
                  <p className="text-muted-foreground">{h.what}</p>
                  <p className="text-muted-foreground italic">{h.wrong}</p>
                </div>
              ))}
            </div>
          </details>
        </SectionCard>
      )}

      <Notes notes={data.notes} />
      {data.segments.map((s) => (
        <SegmentCard key={s.dimension} block={s} />
      ))}
      <Rules rules={data.rules} />
    </>
  );
}

function Figure({
  label,
  value,
  sub,
  emphasis,
  digits,
}: {
  label: string;
  value: number | null;
  sub?: string;
  emphasis?: boolean;
  digits?: number;
}) {
  return (
    <div className={cn("rounded-lg px-2 py-1.5", emphasis && "bg-accent")}>
      <p className="text-muted-foreground text-[12.5px]">{label}</p>
      <p className="text-[20px]">
        <Num value={value} digits={digits} />
      </p>
      {sub && <p className="text-muted-foreground text-[12px]">{sub}</p>}
    </div>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  return (
    <div className="border-line-soft mb-3 border-l-2 pl-3">
      <p className="text-[13.5px] font-medium">
        {finding.title}{" "}
        <span className="text-muted-foreground font-normal">· {finding.fingerprint}</span>
      </p>
      <p className="text-muted-foreground text-[12.5px]">
        {finding.excluded === null
          ? "excludes nothing by design"
          : `${count(finding.excluded)} ${finding.population} over ${finding.windowDays} days`}
        {finding.firstSeen ? ` · first seen ${finding.firstSeen.slice(0, 10)}` : ""}
      </p>
      <ul className="text-muted-foreground mt-1 space-y-0.5 text-[12.5px]">
        {finding.evidence.map((e) => (
          <li key={e}>· {e}</li>
        ))}
      </ul>
    </div>
  );
}

function SegmentCard({ block }: { block: SegmentBlock }) {
  const rows = block.values.slice(0, 12);
  const undrawn = block.values.length - rows.length;
  return (
    <SectionCard
      title={block.dimension}
      meta={`${block.capped ? "at least " : ""}${count(block.total)} ${block.counts} · ${block.startDay} → ${block.endDay}${
        block.capped
          ? " · truncated at the row limit"
          : block.unattributed !== null && block.unattributed > 0
            ? ` · ${count(block.unattributed)} with no ${block.dimension}`
            : ""
      }`}
    >
      {block.gapReason && (
        <p className="text-muted-foreground mb-2 text-[12.5px]">{block.gapReason}</p>
      )}
      {/* THE SHARES ARE THE SERVER'S, of the dimension's own rows — never
          re-derived here from the twelve rows drawn, which would be a share of
          the top twelve wearing a share of everything's clothes. */}
      <RankedBars
        rows={rows.map((r) => ({ label: r.value, value: r.count, share: r.share, change: r.change }))}
        showChange
        footnote={
          undrawn > 0 ? (
            <>
              {undrawn} more value(s) not drawn. The shares above are of {count(block.total)}
              {block.capped
                ? ", which is the row limit rather than the whole distribution — every share here is too big by an amount nobody measured."
                : ", the whole distribution."}
            </>
          ) : undefined
        }
      />
    </SectionCard>
  );
}

/* ----------------------------------------------------------------- events */

function EventsTab({ site, onSite }: { site: string; onSite: (s: string) => void }) {
  return (
    <>
      <SitePicker site={site} onSite={onSite} />
      {site ? <EventsBody site={site} /> : null}
    </>
  );
}

function EventsBody({ site }: { site: string }) {
  const { data, error, loading } = useApi(() => webAnalytics.events(site), [site]);
  if (loading) return <Loading what="the events" />;
  if (error) return <Failed error={error} />;
  const rows = data?.sites[0]?.events ?? [];
  if (!rows.length)
    return (
      <p className="text-muted-foreground text-[14px]">
        No custom events have been collected for this website. Either none are sent, or this site has
        not had its turn in the rotation.
      </p>
    );

  return (
    <>
      {rows.map((e) => (
        <SectionCard
          key={e.event}
          title={e.event}
          meta={`${e.startDay} → ${e.endDay}`}
        >
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure label="occurrences" value={e.occurrences} />
            <Figure label="participants (sessions)" value={e.participants} />
            <Figure label="per participant" value={e.perParticipant} digits={2} sub="repeats, not steps" />
          </div>
          {e.participants === null && e.participantsError && (
            <p className="text-muted-foreground mt-2 text-[12.5px]">{e.participantsError}</p>
          )}
          {e.properties.length > 0 && (
            <table className="mt-3 w-full text-[13px]">
              <thead className="text-muted-foreground text-[12px]">
                <tr>
                  <th className="py-1 text-left font-normal">property</th>
                  <th className="py-1 text-left font-normal">type</th>
                  <th className="py-1 text-right font-normal">records</th>
                  <th className="py-1 text-right font-normal">sum</th>
                  <th className="py-1 pr-3 text-right font-normal">mean</th>
                  <th className="py-1 text-left font-normal">unit</th>
                  <th className="py-1 text-left font-normal">top values</th>
                </tr>
              </thead>
              <tbody>
                {e.properties.map((p) => (
                  <tr key={p.property} className="border-line-soft border-t align-top">
                    <td className="py-1">{p.property}</td>
                    <td className="text-muted-foreground py-1">{p.type}</td>
                    <td className="py-1 text-right">
                      <Num value={p.records} />
                    </td>
                    <td className="py-1 text-right">
                      <Num value={p.numeric?.sum ?? null} digits={2} />
                    </td>
                    <td className="py-1 pr-3 text-right">
                      <Num value={p.numeric?.avg ?? null} digits={2} />
                    </td>
                    <td className={cn("py-1", !p.unit && "text-muted-foreground")}>
                      {p.unit ?? "not stated"}
                    </td>
                    <td className="text-muted-foreground py-1">
                      {p.topValues
                        ? p.topValues
                            .slice(0, 3)
                            .map((v) => `${v.value} (${v.count})`)
                            .join(", ")
                        : p.truncated
                          ? "aggregate refused — a value would not parse"
                          : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>
      ))}
      <Rules rules={data?.rules ?? []} />
    </>
  );
}

/* -------------------------------------------------------------- campaigns */

function CampaignsTab() {
  const map = useApi(() => webAnalytics.campaigns(), []);
  const [busy, setBusy] = useState<string | null>(null);

  async function apply(campaignId: string, venture: string) {
    setBusy(campaignId);
    try {
      await webAnalytics.link(campaignId, venture);
      map.reload();
    } finally {
      setBusy(null);
    }
  }
  async function remove(campaignId: string) {
    setBusy(campaignId);
    try {
      await webAnalytics.unlink(campaignId);
      map.reload();
    } finally {
      setBusy(null);
    }
  }

  if (map.loading) return <Loading what="the campaign map" />;
  if (map.error) return <Failed error={map.error} />;
  const doc = map.data;
  if (!doc) return null;

  return (
    <>
      <SectionCard title="Filed campaigns" meta={`${doc.links.length}`}>
        {doc.links.length ? (
          <ul className="space-y-2">
            {doc.links.map((l) => (
              <li key={l.campaignId} className="flex flex-wrap items-baseline gap-2 text-[13.5px]">
                <span className="font-medium">{l.venture.name ?? l.venture.id}</span>
                <span className="text-muted-foreground">
                  {l.platform} · {l.campaignId} · {l.source}
                </span>
                <button
                  type="button"
                  disabled={busy === l.campaignId}
                  onClick={() => void remove(l.campaignId)}
                  className="border-line-soft ml-auto rounded border px-2 py-0.5 text-[12.5px]"
                >
                  unfile
                </button>
                {l.evidence && (
                  <p className="text-muted-foreground w-full text-[12px]">{l.evidence}</p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-[13.5px]">Nothing is filed yet.</p>
        )}
      </SectionCard>

      <SectionCard title="Suggestions" meta={`${doc.suggestions.length} · nothing is applied until you press`}>
        {doc.suggestions.length ? (
          <ul className="space-y-2">
            {doc.suggestions.map((s) => (
              <li key={`${s.campaignId}|${s.venture.id}`} className="text-[13.5px]">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium">{s.venture.name}</span>
                  <span className="text-muted-foreground">
                    {s.campaignName ?? s.campaignId} · {s.via}
                  </span>
                  {doc.contested.includes(s.campaignId) && (
                    <span className="text-destructive text-[12px]">contested</span>
                  )}
                  <button
                    type="button"
                    disabled={busy === s.campaignId}
                    onClick={() => void apply(s.campaignId, s.venture.id)}
                    className="border-line-soft ml-auto rounded border px-2 py-0.5 text-[12.5px]"
                  >
                    file it
                  </button>
                </div>
                <p className="text-muted-foreground text-[12px]">{s.evidence}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-[13.5px]">
            No campaign matched a venture host. That is a fact about the campaign names and creative
            links, not about the businesses.
          </p>
        )}
      </SectionCard>

      <VentureJoins links={doc.links.map((l) => l.venture.id)} />
      <Rules rules={doc.rules} />
    </>
  );
}

function VentureJoins({ links }: { links: string[] }) {
  const ids = [...new Set(links)];
  if (!ids.length) return null;
  return (
    <>
      {ids.map((id) => (
        <VentureJoinCard key={id} ventureId={id} />
      ))}
    </>
  );
}

function VentureJoinCard({ ventureId }: { ventureId: string }) {
  const { data, error, loading } = useApi(() => webAnalytics.venture(ventureId, 30), [ventureId]);
  if (loading) return <Loading what="the join" />;
  if (error) return <Failed error={error} />;
  if (!data) return null;
  return (
    <SectionCard
      title={data.venture.name}
      meta={`${data.startDay} → ${data.endDay} · blended efficiency, not ROAS`}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <p className="text-muted-foreground text-[12.5px]">ad spend</p>
          <p className="text-[18px]">
            {data.spend.length
              ? data.spend.map((s) => money(s.amount, s.currency)).join(" · ")
              : "—"}
          </p>
        </div>
        <Figure label="clicks (by campaign id)" value={data.clicks} />
        <Figure
          label="tagged views (by name)"
          value={data.taggedViews}
          sub={data.taggedViews === null ? "not measured — see below" : undefined}
        />
        <div>
          <p className="text-muted-foreground text-[12.5px]">blended ratio</p>
          <p className="text-[18px]">
            {data.blended.ratio.length
              ? data.blended.ratio
                  .map((r) => (r.value === null ? `— ${r.currency}` : `${r.value}× ${r.currency}`))
                  .join(" · ")
              : "—"}
          </p>
        </div>
      </div>
      {data.conversions.length > 0 && (
        <p className="mt-3 text-[13.5px]">
          conversions:{" "}
          {data.conversions
            .map((c) => `${c.event} ${c.participants ?? "—"} participants`)
            .join(" · ")}
        </p>
      )}
      <Notes notes={[...data.notes, ...data.blended.unavailable]} />
      <Rules rules={data.blended.rules} />
    </SectionCard>
  );
}

/* -------------------------------------------------------------- creatives */

const VERDICT_TONE: Record<string, string> = {
  fatigued: "text-destructive",
  tiring: "text-warn-foreground",
  steady: "text-muted-foreground",
  "no-verdict": "text-muted-foreground",
};

function CreativesTab() {
  const { data, error, loading } = useApi(() => webAnalytics.creatives(), []);
  if (loading) return <Loading what="the ad-level rows" />;
  if (error) return <Failed error={error} />;
  if (!data) return null;
  if (!data.ads.length)
    return (
      <p className="text-muted-foreground text-[14px]">
        No advertisements have been collected yet. This reads the ad accounts the Meta collector
        already found, so collect Meta first and then this area.
      </p>
    );

  const order = ["fatigued", "tiring", "no-verdict", "steady"];
  const ads = data.ads
    .slice()
    .sort((a, b) => order.indexOf(a.verdict) - order.indexOf(b.verdict));

  return (
    <>
      <SectionCard
        title="Fatigue"
        meta={`${data.compareDays} complete days against the ${data.compareDays} before · under ${count(data.minImpressions)} impressions there is no verdict`}
      >
        <p className="text-muted-foreground mb-3 text-[12.5px]">
          {order.map((k) => `${data.counts[k] ?? 0} ${k}`).join(" · ")}
        </p>
        {ads.map((a) => (
          <AdCard key={a.adId} ad={a} />
        ))}
      </SectionCard>

      {data.statuses.length > 0 && (
        <SectionCard title="Issues and mismatched delivery" meta={`${data.statuses.length}`}>
          <ul className="space-y-2 text-[13.5px]">
            {data.statuses.map((s) => (
              <li key={s.adId}>
                <span className="font-medium">{s.name ?? s.adId}</span>{" "}
                <span className="text-muted-foreground">
                  {s.configuredStatus} configured, {s.status} effective
                  {s.mismatched ? " — reads as live where it was set up and is not delivering" : ""}
                </span>
                {s.issues.length > 0 && (
                  <pre className="text-muted-foreground mt-1 overflow-x-auto text-[12px]">
                    {JSON.stringify(s.issues, null, 1)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard title="Ad sets" meta={`${data.adSets.length}`}>
        <table className="w-full text-[13px]">
          <thead className="text-muted-foreground text-[12px]">
            <tr>
              <th className="py-1 text-left font-normal">name</th>
              <th className="py-1 text-left font-normal">status</th>
              <th className="py-1 text-left font-normal">goal</th>
              <th className="py-1 text-right font-normal">daily budget (minor units)</th>
              <th className="py-1 text-right font-normal">ads</th>
            </tr>
          </thead>
          <tbody>
            {data.adSets.map((s) => (
              <tr key={s.adsetId} className="border-line-soft border-t">
                <td className="py-1">{s.name ?? s.adsetId}</td>
                <td className="text-muted-foreground py-1">{s.status ?? "—"}</td>
                <td className="text-muted-foreground py-1">{s.optimizationGoal ?? "—"}</td>
                <td className="py-1 text-right">
                  <Num value={s.dailyBudgetMinor} />
                  {s.currency ? <span className="text-muted-foreground text-[12px]"> {s.currency}</span> : null}
                </td>
                <td className="py-1 text-right">{s.ads}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </SectionCard>

      <Rules rules={data.rules} />
    </>
  );
}

function AdCard({ ad }: { ad: AdRow }) {
  return (
    <div className="border-line-soft mb-3 border-l-2 pl-3">
      <p className="text-[13.5px]">
        <span className={cn("font-medium", VERDICT_TONE[ad.verdict])}>{ad.verdict}</span>{" "}
        <span>{ad.name ?? ad.adId}</span>{" "}
        <span className="text-muted-foreground">
          {ad.adsetName ? `· ${ad.adsetName} ` : ""}
          {ad.status ?? ""}
          {ad.venture ? ` · ${ad.venture.name}` : ""}
        </span>
      </p>
      {ad.why && <p className="text-muted-foreground text-[12.5px]">{ad.why}</p>}
      {ad.evidence.length > 0 && (
        <ul className="text-muted-foreground mt-1 space-y-0.5 text-[12.5px]">
          {ad.evidence.map((e) => (
            <li key={e}>· {e}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
