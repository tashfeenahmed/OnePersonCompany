import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search } from "lucide-react";
import { PageShell, TopBar } from "@/components/PageShell";
import { OrgChart } from "@/components/org/OrgChart";
import { useApi } from "@/hooks/useApi";
import { subagentApi } from "@/lib/api/subagents";

/**
 * THE ORG CHART, WITH A FILTER OVER IT.
 *
 * The chart itself lives in `components/org/OrgChart.tsx` and is also the
 * roster on the Sub-agents page. What this page adds is the one thing a
 * roster does not want: a filter box, for the day there are nineteen ventures
 * and the question is "which of them has a paper writer that has run". The
 * search reads the workers too, so "paper" finds every venture with a writer
 * rather than only the venture called Papers.
 */
export function Org() {
  const [tick, setTick] = useState(0);
  const doc = useApi(() => subagentApi.org(), [tick]);
  const [q, setQ] = useState("");

  /* Fast while something is in flight, slow while nothing is — the same rule
     the queue page follows. This document is a hundred and fourteen rows and
     four counts; it is not free to build and nobody needs it four times a
     minute while the box is idle. */
  const busy = (doc.data?.summary.running ?? 0) + (doc.data?.summary.queued ?? 0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), busy ? 4000 : 30_000);
    return () => clearInterval(t);
  }, [busy]);

  const ventures = useMemo(() => {
    const all = doc.data?.ventures ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (v) =>
        v.name.toLowerCase().includes(needle) ||
        v.slug.toLowerCase().includes(needle) ||
        v.subagents.some(
          (s) =>
            s.name.toLowerCase().includes(needle) ||
            s.title.toLowerCase().includes(needle) ||
            s.role.includes(needle),
        ),
    );
  }, [doc.data, q]);

  const summary = doc.data?.summary;

  return (
    <>
      <TopBar label="Org chart" />
      <PageShell
        wide
        title="The org"
        sub={
          summary ? (
            <>
              <b className="text-foreground font-medium">{summary.subagents}</b>{" "}
              sub-agents across{" "}
              <b className="text-foreground font-medium">
                {doc.data?.ventures.length ?? 0}
              </b>{" "}
              ventures — provisioned rather than created. {summary.enabled}{" "}
              switched on, {summary.running} working, {summary.queued} waiting.
            </>
          ) : (
            "Every venture's workers, who they report to, and what each of them is doing."
          )
        }
        action={
          <div className="flex items-center gap-2">
            <Link
              to="/subagents"
              className="text-muted-foreground hover:text-foreground text-[13.5px]"
            >
              Sub-agents
            </Link>
            <Link
              to="/ventures"
              className="text-muted-foreground hover:text-foreground text-[13.5px]"
            >
              Back to the list
            </Link>
          </div>
        }
      >
        {doc.error && (
          <p className="text-muted-foreground text-[14px]">
            The org could not be read, so none of it is drawn — an empty chart
            would be a claim that nobody works here.{" "}
            <span className="text-destructive">{doc.error}</span>
          </p>
        )}
        {!doc.data && !doc.error && (
          <p className="text-muted-foreground text-[13.5px]">
            {doc.loading ? "Counting everyone in…" : "Nothing came back."}
          </p>
        )}

        {doc.data && (
          <>
            <div className="mb-4 flex items-center gap-2">
              <div className="relative w-full max-w-[280px]">
                <Search
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2"
                  strokeWidth={1.6}
                />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Filter ventures"
                  className="focus:border-line-strong h-8 w-full rounded-[11px] border bg-transparent pr-2 pl-7 text-[13.5px] outline-none"
                />
              </div>
              {q && (
                <span className="text-muted-foreground text-[12.5px]">
                  {ventures.length} of {doc.data.ventures.length}
                </span>
              )}
            </div>

            <OrgChart
              owner={doc.data.owner}
              chiefOfStaff={doc.data.chiefOfStaff}
              ventures={ventures}
            />

            {!ventures.length && (
              <p className="text-muted-foreground text-[13.5px]">
                {doc.data.ventures.length
                  ? `Nothing matches “${q}”.`
                  : "There are no ventures, so there is nobody to staff. Make one and its workers appear with it."}
              </p>
            )}

            <p className="text-muted-foreground mt-5 text-[12.5px] leading-relaxed">
              Nobody here was created by hand. Every venture gets the same
              workers — one per app — the moment it exists, and a venture that
              is deleted takes them with it. Press a worker to give it a brief,
              change its standing instructions or read what it has already
              done.
            </p>
            {doc.data.roles.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
                {doc.data.roles.map((r) => (
                  <span
                    key={r.role}
                    title={r.what}
                    className="text-muted-foreground text-[12.5px]"
                  >
                    {r.title} · {r.kind}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </PageShell>
    </>
  );
}
