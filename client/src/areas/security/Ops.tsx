import { useState } from "react";
import { useSearchParams, useParams } from "react-router-dom";
import { Camera, ImageOff, Loader2, RefreshCw } from "lucide-react";
import { SubTabs } from "@/components/TabStrip";
import { RunApp } from "@/components/runs/RunApp";
import { Button } from "@/components/ui/button";
import { PageShell } from "@/components/PageShell";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { ago, bytes, count, durationS, pct } from "@/lib/format";
import { VisualQaSection } from "@/areas/seoops/VisualQaSection";
import {
  shotsqaApi,
  snapshotsApi,
  type QaVerdict,
  type Snapshot,
} from "@/lib/api/security";

/**
 * OPS — the two things about the MACHINES that are not a plugin page.
 *
 * TWO TABS INSIDE ONE APP RATHER THAN TWO APPS, which is the opposite of the
 * call the six run apps make next door, and the difference is how often either
 * is opened. A competitor sweep is a thing somebody goes and does and wants a
 * bookmark for; these two are things somebody looks at when something is
 * already wrong. One tab in the strip, a query parameter for the half — so the
 * address is still linkable without spending two slots in a strip that already
 * has eleven.
 */
const TABS = [
  { key: "snapshots", label: "Snapshots" },
  { key: "shotsqa", label: "Shots QA" },
] as const;

export function Ops() {
  const { runId } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "shotsqa" ? "shotsqa" : "snapshots";

  if (runId) return <RunApp kind="shotsqa" slug="ops" name="Screenshot QA" />;
  return (
    <PageShell
      title="Ops"
      sub="What a box was doing at the moment it mattered, and whether the picture on each venture's card is a picture of the site."
      wide
      action={
        <SubTabs
          tabs={TABS}
          activeKey={tab}
          onSelect={(k) => setParams(k === "snapshots" ? {} : { tab: k })}
          className="mb-0"
        />
      }
    >
      {tab === "snapshots" ? <Snapshots /> : <ShotsQa />}
    </PageShell>
  );
}

/* ------------------------------------------------------------- snapshots */

/**
 * A SNAPSHOT IS AN INSTANT AND THIS PAGE NEVER DRAWS A LINE BETWEEN TWO. There
 * is no chart here on purpose: the trend for a box is the Fleet panel, which
 * samples every half hour, and two process lists an hour apart are two moments
 * with nothing measured in between. What this shows is one moment, whole.
 */
function Snapshots() {
  const index = useApi(() => snapshotsApi.index(), []);
  const [open, setOpen] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const doc = useApi(() => (open === null ? Promise.resolve(null) : snapshotsApi.one(open)), [open]);

  async function capture(id: number) {
    setBusy(id);
    setProblem(null);
    try {
      const snap = await snapshotsApi.now(id, "asked for from the Ops page");
      index.reload();
      setOpen(snap.id);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (index.error)
    return <p className="text-muted-foreground text-[14px]">The API is not answering: {index.error}</p>;
  if (!index.data) return <p className="text-muted-foreground text-[14px]">Reading…</p>;

  const d = index.data;

  return (
    <>
      <p className="text-muted-foreground mb-4 max-w-[720px] text-[13.5px] leading-relaxed">{d.note}</p>

      {!d.hosts.length ? (
        <p className="text-muted-foreground text-[14px]">
          No box is connected. Snapshots reach your machines over the Fleet integration's own ssh
          accounts — connect one there and it appears here with nothing else to set up.
        </p>
      ) : (
        <div className="mb-6 overflow-hidden rounded-[14px] border">
          {d.hosts.map((h, i) => (
            <div
              key={h.id}
              className={cn(
                "flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3.5 py-2.5 text-[13.5px]",
                i > 0 && "border-line-soft border-t",
              )}
            >
              <span className="font-medium">{h.label}</span>
              <span className="text-muted-foreground font-mono text-[12.5px]">{h.target}</span>
              <span className="text-muted-foreground ml-auto text-[12.5px]">
                last {h.lastSnapshotAt ? ago(h.lastSnapshotAt) : "never"}
              </span>
              <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void capture(h.id)}>
                {busy === h.id ? (
                  <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                ) : (
                  <Camera className="size-3.5" strokeWidth={1.8} />
                )}
                {busy === h.id ? "Capturing…" : "Capture now"}
              </Button>
            </div>
          ))}
        </div>
      )}

      {problem && <p className="text-destructive mb-4 text-[13.5px]">{problem}</p>}
      {d.problems.map((p) => (
        <p key={p} className="text-muted-foreground mb-2 text-[13.5px]">
          {p}
        </p>
      ))}

      <div className="text-muted-foreground mb-2 text-[12px] tracking-[0.06em] uppercase">
        Snapshots
      </div>
      {!d.snapshots.length ? (
        <p className="text-muted-foreground text-[14px]">
          None yet. Press Capture now, or wait for an uptime host linked to the same venture as a box
          to start failing.
        </p>
      ) : (
        <div className="overflow-hidden rounded-[14px] border">
          {d.snapshots.map((s, i) => (
            <button
              key={s.id}
              onClick={() => setOpen(open === s.id ? null : s.id)}
              className={cn(
                "hover:bg-accent flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3.5 py-2.5 text-left text-[13.5px]",
                i > 0 && "border-line-soft border-t",
                open === s.id && "bg-accent",
              )}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
                  s.ok ? "bg-ok" : "bg-destructive",
                )}
              />
              <span className="font-medium">{s.host}</span>
              <span className="text-muted-foreground min-w-0 truncate">{s.reason}</span>
              <span className="text-muted-foreground ml-auto shrink-0 text-[12.5px] tabular-nums">
                {bytes(s.size)} · {ago(s.ts)}
              </span>
            </button>
          ))}
        </div>
      )}

      {open !== null && (
        <div className="mt-5">
          {doc.error && <p className="text-destructive text-[13.5px]">{doc.error}</p>}
          {doc.data && <SnapshotView snap={doc.data} />}
        </div>
      )}
    </>
  );
}

function Lines({ title, lines, note }: { title: string; lines: string[]; note: string }) {
  return (
    <div className="mt-4">
      <div className="text-muted-foreground mb-1.5 text-[12px] tracking-[0.06em] uppercase">{title}</div>
      {lines.length ? (
        <pre className="bg-card overflow-x-auto rounded-[14px] border px-4.5 py-3.5 font-mono text-[12.5px] leading-relaxed">
          {lines.join("\n")}
        </pre>
      ) : (
        <p className="text-muted-foreground text-[13.5px]">Nothing was returned.</p>
      )}
      <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">{note}</p>
    </div>
  );
}

function SnapshotView({ snap }: { snap: Snapshot }) {
  return (
    <div className="rounded-[14px] border p-4">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[16px]">{snap.host}</span>
        <span className="text-muted-foreground font-mono text-[12.5px]">{snap.target}</span>
        <span className="text-muted-foreground ml-auto text-[12.5px]">
          {snap.ts} · {snap.tookMs} ms
        </span>
      </div>
      <p className="text-muted-foreground mb-3 text-[13.5px]">{snap.reason}</p>

      {!snap.ok && (
        <p className="text-destructive mb-3 text-[13.5px] leading-relaxed">
          The box did not answer: {snap.error}. That is itself the record — this snapshot says the
          machine was unreachable at that moment.
        </p>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {[
          { k: "hostname", v: snap.meta.hostname ?? "—" },
          { k: "kernel", v: snap.meta.kernel ?? "—" },
          { k: "uptime", v: durationS(snap.meta.uptimeS) },
          {
            k: "established connections",
            v: snap.connections.established === null ? "not counted" : count(snap.connections.established),
          },
        ].map((t) => (
          <div key={t.k} className="bg-card min-w-[150px] flex-1 rounded-[14px] border px-4.5 py-3.5">
            <div className="truncate text-[16px] tracking-[-0.02em]" title={t.v}>
              {t.v}
            </div>
            <div className="text-muted-foreground mt-0.5 text-[12.5px]">{t.k}</div>
          </div>
        ))}
      </div>

      {(["byCpu", "byMem"] as const).map((which) => (
        <div key={which} className="mt-4">
          <div className="text-muted-foreground mb-1.5 text-[12px] tracking-[0.06em] uppercase">
            {which === "byCpu" ? "Heaviest by CPU" : "Heaviest by memory"}
          </div>
          <div className="overflow-hidden rounded-[14px] border">
            {snap.processes[which].length ? (
              snap.processes[which].map((p, i) => (
                <div
                  key={`${which}-${i}`}
                  className={cn(
                    "flex items-baseline gap-3 px-3.5 py-1.5 text-[12.5px]",
                    i > 0 && "border-line-soft border-t",
                  )}
                >
                  <span className="w-12 shrink-0 tabular-nums">{pct(p.cpu === null ? null : p.cpu / 100)}</span>
                  <span className="w-12 shrink-0 tabular-nums">{pct(p.mem === null ? null : p.mem / 100)}</span>
                  <span className="text-muted-foreground w-16 shrink-0 truncate">{p.user ?? "—"}</span>
                  <span className="min-w-0 flex-1 truncate font-mono" title={p.command}>
                    {p.command}
                  </span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">{p.elapsed ?? "—"}</span>
                </div>
              ))
            ) : (
              <div className="text-muted-foreground px-3.5 py-2.5 text-[13.5px]">
                No process list was returned.
              </div>
            )}
          </div>
        </div>
      ))}
      <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">{snap.processes.note}</p>

      <Lines
        title={`Listening sockets${snap.ports.tool ? ` · ${snap.ports.tool}` : ""}`}
        lines={snap.ports.lines}
        note={snap.ports.note}
      />
      <Lines title="Filesystems" lines={snap.disks.lines} note={snap.disks.note} />
      <Lines
        title={`Log tail${snap.logs.source ? ` · ${snap.logs.source}` : ""}`}
        lines={snap.logs.lines}
        note={snap.logs.note}
      />
      <Lines title="Containers" lines={snap.docker.lines} note={snap.docker.note} />
    </div>
  );
}

/* ---------------------------------------------------------------- shots QA */

const TONE: Record<QaVerdict, string> = {
  pass: "bg-ok",
  fail: "bg-destructive",
  /* Grey, and never green. An unchecked check is not a passing one — see the
     server's own rules on this route. */
  unchecked: "bg-border",
};

function ShotsQa() {
  const doc = useApi(() => shotsqaApi.get(), []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function runNow() {
    setBusy(true);
    setProblem(null);
    try {
      await shotsqaApi.run();
      /* The pass takes a fraction of a second per venture and joins a queue
         that may be busy, so this waits a beat and re-reads rather than
         polling: the run's own page is where progress is watched. */
      setTimeout(() => doc.reload(), 2500);
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (doc.error)
    return <p className="text-muted-foreground text-[14px]">The API is not answering: {doc.error}</p>;
  if (!doc.data) return <p className="text-muted-foreground text-[14px]">Reading…</p>;

  const d = doc.data;
  const failing = d.ventures.filter((v) => v.failed > 0);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-baseline gap-3">
        <span className="text-[14px]">
          {d.ts ? (
            <>
              Last pass {ago(d.ts)} — {d.ventures.length} venture(s), {failing.length} with a failed
              check
            </>
          ) : (
            "No pass has been run yet."
          )}
        </span>
        <Button variant="outline" size="sm" className="ml-auto" disabled={busy} onClick={() => void runNow()}>
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
          ) : (
            <RefreshCw className="size-3.5" strokeWidth={1.8} />
          )}
          {busy ? "Queued…" : "Run now"}
        </Button>
      </div>
      {problem && <p className="text-destructive mb-3 text-[13.5px]">{problem}</p>}
      <p className="text-muted-foreground mb-4 max-w-[720px] text-[13.5px] leading-relaxed">{d.note}</p>

      {!d.ventures.length ? (
        <p className="text-muted-foreground text-[14px]">
          Nothing has been examined yet. Press Run now — it asks no model and costs nothing.
        </p>
      ) : (
        <div className="overflow-hidden rounded-[14px] border">
          {d.ventures.map((v, i) => (
            <div key={v.ventureId} className={cn(i > 0 && "border-line-soft border-t")}>
              <button
                onClick={() => setOpen(open === v.ventureId ? null : v.ventureId)}
                className="hover:bg-accent flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-3.5 py-2.5 text-left text-[13.5px]"
              >
                <span className="flex shrink-0 gap-1">
                  {v.checks.map((c) => (
                    <span
                      key={c.key}
                      title={`${c.label}: ${c.verdict}`}
                      className={cn("size-1.5 translate-y-[-1px] rounded-full", TONE[c.verdict])}
                    />
                  ))}
                </span>
                <span className="font-medium">{v.venture}</span>
                {v.failed > 0 && (
                  <span className="text-destructive">
                    {v.failed} failed
                  </span>
                )}
                {v.unchecked > 0 && (
                  <span className="text-muted-foreground">{v.unchecked} unchecked</span>
                )}
                <span className="text-muted-foreground ml-auto shrink-0 text-[12.5px] tabular-nums">
                  {v.width && v.height ? `${v.width}x${v.height} · ` : ""}
                  {v.shotTs ? ago(v.shotTs) : "never captured"}
                </span>
              </button>
              {open === v.ventureId && (
                <div className="border-line-soft border-t px-3.5 py-3">
                  {v.checks.map((c) => (
                    <div key={c.key} className="mb-1.5 flex gap-2 text-[13px] last:mb-0">
                      <span
                        className={cn(
                          "mt-1.5 size-1.5 shrink-0 rounded-full",
                          TONE[c.verdict],
                        )}
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{c.label}</span>{" "}
                        <span className="text-muted-foreground">— {c.detail}</span>
                      </span>
                    </div>
                  ))}
                  {v.pixels === null && (
                    <p className="text-muted-foreground mt-2 flex items-center gap-1.5 text-[12.5px]">
                      <ImageOff className="size-3.5" strokeWidth={1.8} />
                      The image was not decoded, so the blankness figures are absent rather than zero.
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* THE MODEL'S OPINIONS, UNDER THE MEASUREMENTS AND NOT INSIDE THEM. The
          table above is arithmetic over the PNG; this is a model looking at
          the same picture. Two different kinds of claim, so two blocks. */}
      <VisualQaSection />

      {d.passes.length > 1 && (
        <>
          <div className="text-muted-foreground mt-6 mb-2 text-[12px] tracking-[0.06em] uppercase">
            Earlier passes
          </div>
          <div className="overflow-hidden rounded-[14px] border">
            {d.passes.map((p, i) => (
              <div
                key={p.runId}
                className={cn(
                  "flex flex-wrap items-baseline gap-x-3 px-3.5 py-2 text-[13px]",
                  i > 0 && "border-line-soft border-t",
                )}
              >
                <span className="font-mono">{p.runId}</span>
                <span className="text-muted-foreground">{ago(p.ts)}</span>
                <span className="text-muted-foreground ml-auto tabular-nums">
                  {p.ventures} ventures · {p.failed} failed · {p.unchecked} unchecked
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
