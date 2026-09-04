import { useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { PageShell, TopBar } from "@/components/PageShell";
import { cn } from "@/lib/utils";
import {
  AGENT_GLYPHS,
  LANES,
  SUBAGENTS,
  type Lane,
  type Subagent,
} from "@/data/subagents";

/** These are workers, not brands, so the roster uses the shell's own stroke
 *  language rather than a colour tile. */
function Glyph({ name, className }: { name: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-4", className)}
      aria-hidden
      dangerouslySetInnerHTML={{
        __html: AGENT_GLYPHS[name] ?? AGENT_GLYPHS.activity,
      }}
    />
  );
}

function stateOf(a: Subagent) {
  return a.running ? "running" : a.waiting ? "waiting" : "idle";
}

function stateLine(a: Subagent) {
  if (a.running) return "Working";
  if (a.waiting)
    return `${a.waiting} ${a.waiting === 1 ? "run" : "runs"} waiting`;
  return `Idle · last ${a.last}`;
}

export function Subagents() {
  const [open, setOpen] = useState<Subagent | null>(null);

  const running = SUBAGENTS.filter((a) => a.running).length;
  const waiting = SUBAGENTS.reduce((n, a) => n + a.waiting, 0);
  const finished = SUBAGENTS.reduce((n, a) => n + a.history.length, 0);
  const failed = SUBAGENTS.reduce(
    (n, a) => n + a.history.filter((h) => h === "failed").length,
    0,
  );

  const stats: [number, string][] = [
    [running, "working now"],
    [waiting, "runs waiting"],
    [finished, "finished · 48h window"],
    [failed, failed === 1 ? "failure" : "failures"],
  ];

  return (
    <>
      <TopBar label="Sub-agents">
        <button
          onClick={() => location.reload()}
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px]"
        >
          <RefreshCw className="size-3.5" strokeWidth={1.6} />
          Refresh queue
        </button>
      </TopBar>

      <PageShell
        title="Sub-agents"
        sub="The standing workers, one per kind of job, read off the queue they all drain through."
      >
        <div className="mb-5.5 flex flex-wrap gap-2">
          {stats.map(([v, k]) => (
            <div
              key={k}
              className="bg-card min-w-[150px] flex-1 rounded-[10px] border px-3.5 py-3"
            >
              <div className="text-[22px] font-normal tracking-[-0.03em] tabular-nums">
                {v}
              </div>
              <div className="text-muted-foreground mt-0.5 text-[11.5px]">
                {k}
              </div>
            </div>
          ))}
        </div>

        {(Object.keys(LANES) as Lane[]).map((laneId) => {
          const lane = LANES[laneId];
          const mine = SUBAGENTS.filter((a) => a.lane === laneId);

          return (
            <div key={laneId} className="mb-7.5">
              <div className="mb-1 flex items-baseline gap-2.5">
                <span className="text-[13px] font-medium tracking-tight">
                  {lane.name}
                </span>
                <span className="text-muted-foreground text-[12px]">
                  {mine.length} workers · {lane.rule}
                </span>
              </div>
              <p className="text-muted-foreground mb-3 max-w-[640px] text-[12.5px]">
                {lane.note}
              </p>

              <div className="flex flex-col gap-1.5">
                {mine.map((a) => {
                  const s = stateOf(a);
                  return (
                    <button
                      key={a.kind}
                      onClick={() => setOpen(a)}
                      className="bg-card hover:border-line-strong flex w-full items-center gap-3 rounded-[10px] border px-3.5 py-3 text-left transition-colors"
                    >
                      <div
                        className={cn(
                          "grid size-8 shrink-0 place-items-center rounded-[9px]",
                          s === "running" ? "bg-ok-bg text-ok" : "bg-muted",
                        )}
                      >
                        <Glyph name={a.icon} />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[13.5px] font-medium tracking-tight">
                            {a.name}
                          </span>
                          <span className="text-muted-foreground pt-px font-mono text-[11px]">
                            {a.kind}
                          </span>
                        </div>
                        <p className="text-muted-foreground mt-0.5 truncate text-[12px]">
                          {a.what}
                        </p>
                      </div>

                      <div className="hidden shrink-0 items-center gap-0.5 sm:flex">
                        {a.history
                          .slice(0, 8)
                          .reverse()
                          .map((h, i) => (
                            <span
                              key={i}
                              title={h}
                              className={cn(
                                "h-4 w-[5px] rounded-sm",
                                h === "done" && "bg-ok opacity-55",
                                h === "failed" && "bg-destructive opacity-70",
                                h === "cancelled" && "bg-border",
                              )}
                            />
                          ))}
                      </div>

                      <div className="flex w-[150px] shrink-0 flex-col items-end gap-1 lg:w-[208px]">
                        <span className="flex items-center gap-1.5 text-[12px]">
                          <span
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              s === "running" && "bg-ok animate-pulse",
                              s === "waiting" && "bg-warn",
                              s === "idle" && "bg-border",
                            )}
                          />
                          {stateLine(a)}
                        </span>
                        <span className="text-muted-foreground max-w-full truncate text-[11.5px]">
                          {a.running || a.waiting ? a.target : "—"}
                        </span>
                      </div>

                      <span className="text-muted-foreground hidden shrink-0 items-center gap-1.5 rounded-[7px] px-2 py-1 text-[11.5px] lg:flex">
                        <ExternalLink className="size-3" strokeWidth={1.6} />
                        {a.module}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        <p className="text-muted-foreground pt-4 text-[13px]">
          History goes back as far as the queue remembers — finished runs are
          kept for 48 hours, so this is the server's memory rather than a
          ledger.
        </p>
      </PageShell>

      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full gap-0 p-0 sm:max-w-[420px]">
          {open && (
            <>
              <SheetHeader className="border-line-soft flex-row items-center gap-3 space-y-0 border-b px-5 py-4.5">
                <div
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-[9px]",
                    open.running ? "bg-ok-bg text-ok" : "bg-muted",
                  )}
                >
                  <Glyph name={open.icon} />
                </div>
                <div className="min-w-0">
                  <SheetTitle className="text-base font-medium tracking-tight">
                    {open.name}
                  </SheetTitle>
                  <SheetDescription className="text-[12px]">
                    {LANES[open.lane].name} · {open.kind}
                  </SheetDescription>
                </div>
              </SheetHeader>

              <div className="flex-1 overflow-y-auto px-5 py-4.5">
                <p className="text-muted-foreground mb-4 text-[13px]">
                  {open.what}
                </p>

                {[
                  [
                    "Queue kind",
                    <code
                      key="k"
                      className="text-muted-foreground font-mono text-[11.5px]"
                    >
                      {open.kind}
                    </code>,
                  ],
                  [
                    "Lane",
                    `${LANES[open.lane].name} — ${LANES[open.lane].rule}`,
                  ],
                  ["Output lands", open.module],
                ].map(([k, v]) => (
                  <div
                    key={String(k)}
                    className="flex gap-2.5 py-1.5 text-[12.5px]"
                  >
                    <span className="text-muted-foreground w-[92px] shrink-0">
                      {k}
                    </span>
                    <span>{v}</span>
                  </div>
                ))}

                <div className="text-muted-foreground mt-5 mb-2 text-[11px] tracking-[0.06em] uppercase">
                  Now
                </div>
                {open.running ? (
                  <Row tone="ok" label={open.target} when="working" />
                ) : (
                  <p className="text-muted-foreground py-1.5 text-[13px]">
                    Idle. Last run {open.last}.
                  </p>
                )}
                {Array.from({ length: open.waiting }, (_, i) => (
                  <Row key={i} tone="idle" label={open.target} when="waiting" />
                ))}

                <div className="text-muted-foreground mt-5 mb-2 text-[11px] tracking-[0.06em] uppercase">
                  Recent runs
                </div>
                {open.history.map((h, i) => (
                  <Row
                    key={i}
                    tone={h === "done" ? "ok" : h === "failed" ? "bad" : "idle"}
                    label={`${open.name} — ${open.target}`}
                    when={`${h} · ${(i + 1) * 3}h ago`}
                  />
                ))}
              </div>

              <SheetFooter className="border-line-soft flex-row items-center gap-2 border-t px-5 py-3.5">
                <Button onClick={() => setOpen(null)}>
                  {open.running ? "Queue another" : "Run now"}
                </Button>
                <Button
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => setOpen(null)}
                >
                  Open module
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function Row({
  tone,
  label,
  when,
}: {
  tone: "ok" | "bad" | "idle";
  label: string;
  when: string;
}) {
  return (
    <div className="border-line-soft flex items-center gap-2.5 border-b py-1.5 last:border-b-0">
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tone === "ok" && "bg-ok",
          tone === "bad" && "bg-destructive",
          tone === "idle" && "bg-muted-foreground",
        )}
      />
      <span className="min-w-0 truncate text-[12.5px]">{label}</span>
      <span className="text-muted-foreground ml-auto text-[11.5px] whitespace-nowrap">
        {when}
      </span>
    </div>
  );
}
