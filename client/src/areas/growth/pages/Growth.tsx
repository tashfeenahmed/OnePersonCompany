import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Check, RefreshCw } from "lucide-react";
import { SubTabs } from "@/components/TabStrip";
import { PageShell } from "@/components/PageShell";
import { VentureSelect } from "@/components/VentureSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Failed, Loading } from "@/components/ui/state";
import { useApi } from "@/hooks/useApi";
import { count, pct } from "@/lib/format";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { growthApi, type AdsHealth, type Authority, type Cro, type Indexing, type SubmitResult } from "@/areas/growth/api";

/**
 * GROWTH — four readings that share one question and no data.
 *
 * WHY FOUR TABS AND NOT FOUR APPS. Authority, CRO, Indexing and Ads health are
 * read at the same moment — "is anybody finding this, and do they do anything
 * when they arrive" — and each is a page and a half. Four tabs on the app bar
 * would put four half-empty pages where one belongs; four sections stacked on
 * one page would put an ad account's rubric under a keyword ceiling. The tab is
 * in the query string so each is still a link somebody can send.
 *
 * WHAT THIS PAGE MAY NEVER DO, and it is the same rule in four places:
 *
 *   * NEVER RANK THE HOSTS. An authority estimate is the mean of whichever
 *     parts could be read for that host; two hosts measured on different parts
 *     are two measurements wearing one word, and a sorted column would invent
 *     the comparison the server's own note refuses to make.
 *   * NEVER DRAW A NULL AS A ZERO. A check that was not evaluated, a ratio
 *     under the sample floor, a rating nobody has given — all of them are "—"
 *     with the reason beside them.
 *   * NEVER CALL A SUBMISSION AN INDEXING. IndexNow's 200 means received. The
 *     page says received.
 *   * NEVER SHOW A SCORE WITHOUT ITS PARTS. Both scores here are this app's own
 *     rubric, and the arithmetic that produced them is one press away on the
 *     same card rather than in a document nobody opens.
 */

const TABS = [
  { key: "authority", label: "Authority" },
  { key: "cro", label: "CRO" },
  { key: "indexing", label: "Indexing" },
  { key: "ads", label: "Ads health" },
];

export function Growth() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.find((t) => t.key === params.get("tab"))?.key ?? "authority";

  return (
    <PageShell
      title="Growth"
      wide
      sub="Four readings computed from what this box already collected: how much authority a host has, where a funnel leaks, what has been told to IndexNow, and whether an ad account is healthy."
    >
      <SubTabs
        tabs={TABS}
        activeKey={tab}
        onSelect={(k) => setParams(k === "authority" ? {} : { tab: k })}
        rule
      />

      {tab === "authority" && <AuthorityTab />}
      {tab === "cro" && <CroTab />}
      {tab === "indexing" && <IndexingTab />}
      {tab === "ads" && <AdsTab />}
    </PageShell>
  );
}

/* ------------------------------------------------------------ small parts */

/** The working, folded away. Open by a press, because an arithmetic block
 *  nobody can see is a score nobody can check. */
function Working({ lines, label = "the arithmetic" }: { lines: string[]; label?: string }) {
  return (
    <details className="mt-3">
      <summary className="text-muted-foreground cursor-pointer text-[12.5px] select-none">{label}</summary>
      <ul className="text-muted-foreground mt-2 space-y-1 text-[12.5px]">
        {lines.map((l) => (
          <li key={l} className="leading-[1.55]">
            {l}
          </li>
        ))}
      </ul>
    </details>
  );
}

const n = (v: number | null | undefined) => (v === null || v === undefined ? "—" : String(v));

/* --------------------------------------------------------------- authority */

function AuthorityTab() {
  const doc = useApi(() => growthApi.authority(), []);
  if (doc.loading) return <Loading what="the authority estimates" />;
  if (doc.error) return <Failed error={doc.error} />;
  if (!doc.data) return null;

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-[13px] leading-[1.6]">
        {doc.data.label}. {doc.data.note}
      </p>
      {doc.data.hosts.map((h) => (
        <AuthorityCard key={h.host} a={h} />
      ))}
    </div>
  );
}

function AuthorityCard({ a }: { a: Authority }) {
  return (
    <div className="bg-card rounded-[14px] border px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px]">{a.host}</span>
        <span className="text-[24px] leading-none tracking-[-0.02em]">{a.estimate === null ? "—" : a.estimate}</span>
        <span className="text-muted-foreground text-[12.5px]">
          {a.estimate === null
            ? "no estimate — nothing about this host could be read"
            : `from ${a.basis.join(" + ")}${a.missing.length ? `; ${a.missing.join(", ")} not measured` : ""}`}
        </span>
        <span className="ml-auto text-[12.5px]">
          {a.ceiling === null ? (
            <span className="text-muted-foreground">
              {a.estimate === null ? "no ceiling" : "no ceiling stated at this size"}
            </span>
          ) : (
            <>
              keyword difficulty ceiling <span className="text-[14px]">{a.ceiling}</span>
            </>
          )}
        </span>
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="text-muted-foreground text-[12.5px]">
            <tr className="border-line-soft border-b">
              <th className="py-1 pr-3 text-left font-normal">Part</th>
              <th className="py-1 pr-3 text-right font-normal">Input</th>
              <th className="py-1 pr-3 text-right font-normal">0–100</th>
              <th className="py-1 text-left font-normal">Source</th>
            </tr>
          </thead>
          <tbody>
            {a.parts.map((p) => (
              <tr key={p.name} className="border-line-soft border-b last:border-0">
                <td className="py-1.5 pr-3">{p.name}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{n(p.input)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{n(p.score)}</td>
                <td className="text-muted-foreground py-1.5 text-[12.5px]">
                  {p.from ?? "not measured — dropped from the mean, not counted as zero"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {a.links.sources.length > 0 && (
        <p className="text-muted-foreground mt-2 text-[12.5px]">
          Link sources, never added together: {a.links.sources.map((s) => `${s.source} ${s.referringDomains ?? "no figure"}`).join(", ")}
          {a.links.spread !== null ? `; ${a.links.spread} distinct linking domains stored, ${a.links.verifiedLive} verified live` : ""}.
        </p>
      )}
      {a.note && <p className="text-muted-foreground mt-1.5 text-[12.5px]">{a.note}</p>}
      <Working lines={a.arithmetic} />
    </div>
  );
}

/* --------------------------------------------------------------------- cro */

function CroTab() {
  const { state } = useStore();
  const ventures = state.ventures ?? [];
  const [ventureId, setVentureId] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /* THE CHOICE IS DERIVED RATHER THAN SEEDED. The roster arrives from the
     server after the first render, so a `useState(ventures[0])` initialiser
     is evaluated against an empty list and the page sits on "choose a
     venture" forever. Falling back to the first one on every render means the
     page is useful the moment the roster lands and still honours a choice. */
  const venture = ventures.find((v) => v.id === ventureId) ?? ventures[0] ?? null;
  const doc = useApi(
    () => (venture ? growthApi.cro(venture.slug, stage) : Promise.resolve(null as Cro | null)),
    [venture?.slug, stage, tick],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <VentureSelect ventures={ventures} value={venture?.id ?? null} onChange={setVentureId} />
        <select
          value={stage ?? ""}
          onChange={(e) => setStage(e.target.value || null)}
          className="bg-card h-9 rounded-[12px] border px-3 text-[13.5px]"
        >
          <option value="">Stage: whatever the funnel says</option>
          {(doc.data?.stages ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              Stage: {s.id} (chosen by me)
            </option>
          ))}
        </select>
        <Button variant="ghost" size="sm" onClick={() => setTick((t) => t + 1)} title="Read it again">
          <RefreshCw className="size-3.5" strokeWidth={1.6} />
        </Button>
      </div>

      {doc.loading && <Loading what="the funnel" />}
      {doc.error && <Failed error={doc.error} />}
      {doc.data && <CroBody doc={doc.data} onChange={() => setTick((t) => t + 1)} />}
    </div>
  );
}

function CroBody({ doc, onChange }: { doc: Cro; onChange: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, string>>({});
  const running = new Map(doc.experiments.map((e) => [e.experiment, e]));

  const start = async (id: string) => {
    setBusy(id);
    try {
      await growthApi.croStart(doc.venture.slug, id, doc.funnel.stage);
      onChange();
    } finally {
      setBusy(null);
    }
  };
  const finish = async (id: string, outcome: "done" | "dropped") => {
    setBusy(id);
    try {
      await growthApi.croFinish(doc.venture.slug, id, outcome, result[id] ?? "");
      onChange();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-card rounded-[14px] border px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-[14.5px]">
            {doc.funnel.stage ? (
              <>
                The stage that leaks: <span className="text-[16px]">{doc.funnel.stage}</span>
              </>
            ) : (
              "No stage could be measured"
            )}
          </span>
          {doc.funnel.source && <span className="text-muted-foreground text-[12.5px]">read from {doc.funnel.source}</span>}
        </div>
        <p className="text-muted-foreground mt-1.5 text-[13px] leading-[1.6]">{doc.funnel.why}</p>

        {doc.funnel.steps.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {doc.funnel.steps.map((s, i) => (
              <span key={s.stage} className="flex items-center gap-2">
                <span className="bg-background rounded-[11px] border px-2.5 py-1.5 text-[13px]">
                  <span className="text-muted-foreground">{s.stage}</span> <span className="tabular-nums">{count(s.count)}</span>
                  <span className="text-muted-foreground text-[12px]"> · {s.key}</span>
                </span>
                {i < doc.funnel.transitions.length && (
                  <span className="text-muted-foreground text-[12.5px] tabular-nums" title={doc.funnel.transitions[i]!.why}>
                    → {pct(doc.funnel.transitions[i]!.ratio, { digits: 2, nullText: "not computed" })}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
        {doc.funnel.tried.length > 0 && (
          <ul className="text-muted-foreground mt-2 space-y-1 text-[12.5px]">
            {doc.funnel.tried.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        )}
      </div>

      {doc.experiments.length > 0 && (
        <div>
          <h2 className="mb-2 text-[14.5px]">Experiments on this venture</h2>
          <div className="space-y-2">
            {doc.experiments.map((e) => (
              <div key={e.experiment} className="bg-card rounded-[14px] border px-4.5 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13.5px]">{e.detail?.hypothesis ?? e.experiment}</span>
                  <span
                    className={cn(
                      "ml-auto rounded-[8px] px-1.5 py-0.5 text-[12px]",
                      e.status === "running" ? "bg-warn/20" : e.status === "done" ? "bg-ok/20" : "text-muted-foreground border",
                    )}
                  >
                    {e.status}
                  </span>
                </div>
                <p className="text-muted-foreground mt-1 text-[12.5px]">
                  {e.experiment} · {e.stage ?? "no stage"} · started {e.startedAt?.slice(0, 10) ?? "—"}
                  {e.finishedAt ? ` · finished ${e.finishedAt.slice(0, 10)}` : ""}
                  {e.result ? ` · ${e.result}` : ""}
                </p>
                {e.status === "running" && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Input
                      value={result[e.experiment] ?? ""}
                      onChange={(ev) => setResult((r) => ({ ...r, [e.experiment]: ev.target.value }))}
                      placeholder="What happened?"
                      className="h-8 max-w-[320px] text-[13px]"
                    />
                    <Button size="sm" variant="outline" disabled={busy === e.experiment} onClick={() => finish(e.experiment, "done")}>
                      Done
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy === e.experiment} onClick={() => finish(e.experiment, "dropped")}>
                      Dropped
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className="mb-1 text-[14.5px]">
          {doc.shortlist.length ? `The ${doc.funnel.stage} bucket, biggest lever first` : "The whole library — nothing named a stage, so nothing is shortlisted"}
        </h2>
        <p className="text-muted-foreground mb-2 text-[12.5px] leading-[1.6]">{doc.note}</p>
        <div className="space-y-2">
          {(doc.shortlist.length ? doc.shortlist : doc.library).map((x) => {
            const row = running.get(x.id);
            return (
              <div key={x.id} className="bg-card rounded-[14px] border px-4.5 py-3.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-muted-foreground text-[12px]">
                    {x.stage} · {x.dimension} · rank {x.rank} · {x.effort}
                  </span>
                  <div className="ml-auto">
                    {row && row.status === "running" ? (
                      <span className="text-muted-foreground flex items-center gap-1 text-[12.5px]">
                        <Check className="size-3" strokeWidth={2} /> running
                      </span>
                    ) : (
                      <Button size="sm" variant="outline" disabled={busy === x.id} onClick={() => start(x.id)}>
                        Start
                      </Button>
                    )}
                  </div>
                </div>
                <p className="mt-1 text-[13.5px] leading-[1.6]">{x.hypothesis}</p>
                <p className="text-muted-foreground mt-1 text-[13px] leading-[1.6]">
                  <span className="text-foreground">Change:</span> {x.change}
                </p>
                <p className="text-muted-foreground mt-0.5 text-[13px] leading-[1.6]">
                  <span className="text-foreground">Measure:</span> {x.measure}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      <details>
        <summary className="text-muted-foreground cursor-pointer text-[12.5px] select-none">what this library will never suggest</summary>
        <ul className="text-muted-foreground mt-2 space-y-1 text-[12.5px]">
          {doc.refusals.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/* ---------------------------------------------------------------- indexing */

function IndexingTab() {
  const { state } = useStore();
  const hosts = (state.ventures ?? []).map((v) => v.host).filter((h): h is string => !!h);
  /* THE HOST IS IN THE QUERY STRING, so a submission log is a link somebody
     can send. Derived for CroTab's reason as well: the ventures land after the
     first render, so a host that is not in the roster yet falls back to the
     first one rather than leaving the page empty. */
  const [params, setParams] = useSearchParams();
  const chosen = params.get("host") ?? "";
  const host = hosts.includes(chosen) ? chosen : (hosts[0] ?? "");
  const setHost = (h: string) => setParams({ tab: "indexing", host: h });
  const [tick, setTick] = useState(0);
  const [check, setCheck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<SubmitResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const doc = useApi(() => (host ? growthApi.indexing(host, check) : Promise.resolve(null as Indexing | null)), [host, check, tick]);

  const submit = async (body: { audit?: boolean; sitemap?: boolean; dryRun?: boolean }) => {
    setBusy(true);
    setError(null);
    setSent(null);
    try {
      setSent(await growthApi.submit({ host, ...body }));
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={host} onChange={(e) => setHost(e.target.value)} className="bg-card h-9 rounded-[12px] border px-3 text-[13.5px]">
          {hosts.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <Button size="sm" variant={check ? "default" : "outline"} onClick={() => setCheck((c) => !c)}>
          {check ? "Checking the key file" : "Check the key file"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setTick((t) => t + 1)}>
          <RefreshCw className="size-3.5" strokeWidth={1.6} />
        </Button>
      </div>

      {doc.loading && <Loading what="the indexing document" />}
      {doc.error && <Failed error={doc.error} />}
      {doc.data && (
        <>
          <div className="bg-card rounded-[14px] border px-5 py-4">
            <p className="text-[14px]">
              Key <code className="bg-background rounded-[8px] border px-1.5 py-0.5 text-[13px]">{doc.data.key}</code>
            </p>
            <p className="text-muted-foreground mt-2 text-[13px] leading-[1.65]">{doc.data.instruction}</p>
            {doc.data.keyFile && (
              <p className={cn("mt-2 text-[13px]", doc.data.keyFile.hosted ? "text-ok" : "text-destructive")}>
                {doc.data.keyFile.hosted ? "The key file is in place. " : "The key file is not in place. "}
                {doc.data.keyFile.why}
              </p>
            )}
            <p className="text-muted-foreground mt-2 text-[12.5px] leading-[1.6]">{doc.data.means}</p>
            <p className="text-muted-foreground mt-1 text-[12.5px] leading-[1.6]">{doc.data.engines}</p>
            <p className="text-muted-foreground mt-1 text-[12.5px] leading-[1.6]">{doc.data.google}</p>
          </div>

          <div className="bg-card rounded-[14px] border px-5 py-4">
            <p className="text-[14px]">What the last two audits found</p>
            <p className="text-muted-foreground mt-1 text-[13px] leading-[1.6]">{doc.data.audit.why}</p>
            <p className="text-muted-foreground mt-2 text-[12.5px]">
              Sitemap: {doc.data.sitemaps.map((s) => `${s.url}${s.configured ? "" : " (assumed, not configured)"}`).join(", ")} · auto-submit{" "}
              {doc.data.autoSubmit ? "on" : "off"}
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => submit({ audit: true })}>
                Submit what the audit found
              </Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => submit({ sitemap: true })}>
                Submit the sitemap's URLs
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => submit({ audit: true, dryRun: true })}>
                Dry run
              </Button>
            </div>
            {error && <p className="text-destructive mt-2 text-[13px]">{error}</p>}
            {sent && (
              <p className={cn("mt-2 text-[13px] leading-[1.6]", sent.outcome === "dry-run" ? "text-warn" : "text-ok")}>
                {sent.outcome} · {sent.submitted} URLs · {sent.what}
              </p>
            )}
          </div>

          <div>
            <h2 className="mb-2 text-[14.5px]">The log</h2>
            {doc.data.submissions.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">Nothing has been submitted for {doc.data.host}.</p>
            ) : (
              <div className="bg-card overflow-x-auto rounded-[14px] border">
                <table className="w-full text-[13px]">
                  <thead className="text-muted-foreground text-[12.5px]">
                    <tr className="border-line-soft border-b">
                      <th className="px-3 py-1.5 text-left font-normal">When</th>
                      <th className="px-3 py-1.5 text-left font-normal">URL</th>
                      <th className="px-3 py-1.5 text-left font-normal">Why</th>
                      <th className="px-3 py-1.5 text-left font-normal">Outcome</th>
                    </tr>
                  </thead>
                  <tbody>
                    {doc.data.submissions.slice(0, 40).map((s) => (
                      <tr key={s.id} className="border-line-soft border-b last:border-0">
                        <td className="text-muted-foreground px-3 py-1.5 whitespace-nowrap">{s.submittedAt.slice(0, 16).replace("T", " ")}</td>
                        <td className="max-w-[320px] truncate px-3 py-1.5" title={s.url}>
                          {s.url}
                        </td>
                        <td className="text-muted-foreground px-3 py-1.5">{s.reason}</td>
                        <td className="px-3 py-1.5" title={s.response ?? ""}>
                          {s.outcome}
                          {s.status === null ? "" : ` (${s.status})`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- ads */

function AdsTab() {
  const doc = useApi(() => growthApi.ads(), []);
  if (doc.loading) return <Loading what="the ad accounts" />;
  if (doc.error) return <Failed error={doc.error} />;
  if (!doc.data) return null;
  if (!doc.data.accounts.length)
    return <p className="text-muted-foreground text-[14px]">No Meta ad account has been collected, so there is nothing to score.</p>;

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-[13px] leading-[1.6]">{doc.data.note}</p>
      {doc.data.accounts.map((a) => (
        <AdsCard key={a.account.id} a={a} />
      ))}
    </div>
  );
}

function AdsCard({ a }: { a: AdsHealth }) {
  return (
    <div className="bg-card rounded-[14px] border px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[15px]">{a.account.name ?? a.account.id}</span>
        <span className="text-[24px] leading-none tracking-[-0.02em]">{a.score === null ? "—" : a.score}</span>
        {a.grade && <span className="text-muted-foreground text-[13px]">{a.grade}</span>}
        <span className="text-muted-foreground text-[12.5px]">
          {a.refusal ?? `${a.coverage} of the rubric's weight could be evaluated`}
        </span>
        <span className="text-muted-foreground ml-auto text-[12.5px]">
          {a.account.window.from} → {a.account.window.to} · {a.account.spend ?? "—"} {a.account.currency} · {a.account.leads ?? "—"} leads
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {Object.entries(a.categories).map(([name, c]) => (
          <div key={name} className="bg-background min-w-[128px] flex-1 rounded-[12px] border px-3 py-2">
            <p className="text-muted-foreground text-[12px]">
              {name} · weight {c.weight}
            </p>
            <p className="text-[17px] tabular-nums">{c.score === null ? "—" : c.score}</p>
            <p className="text-muted-foreground text-[12px] leading-[1.5]">{c.reason ?? `coverage ${c.coverage}`}</p>
          </div>
        ))}
      </div>

      {a.failing.length > 0 && (
        <div className="mt-3 space-y-1.5">
          {a.failing.map((f) => (
            <div key={f.id} className="border-line-soft rounded-[12px] border px-3 py-2">
              <p className="text-[13.5px]">
                <span className={cn(f.result === "fail" ? "text-destructive" : "text-warn")}>{f.result}</span> · {f.title}
                <span className="text-muted-foreground text-[12px]"> · {f.severity}</span>
              </p>
              <p className="text-muted-foreground mt-1 text-[12.5px] leading-[1.6]">{f.detail}</p>
              <p className="text-muted-foreground mt-0.5 text-[12.5px] leading-[1.6]">{f.fix}</p>
            </div>
          ))}
        </div>
      )}

      <Working lines={a.arithmetic} />
      <Working lines={a.checks.map((c) => `${c.id} — ${c.result ?? "not evaluated"} — ${c.detail}`)} label="every check, and what it was computed from" />
      <Working lines={a.limitations} label="what this cannot see" />
      <p className="text-muted-foreground mt-3 text-[12.5px] leading-[1.6]">{a.means}</p>
      <p className="text-muted-foreground mt-1 text-[12.5px] leading-[1.6]">
        Target cost per lead: {a.target.costPerLead ?? "none"} — {a.target.basis}{" "}
        <Link to="/integrations/meta" className="underline">
          Meta
        </Link>
      </p>
    </div>
  );
}
