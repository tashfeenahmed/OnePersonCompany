import { useState } from "react";
import { Box, ServerIcon } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import { integrations } from "@/lib/api/integrations";
import { cn } from "@/lib/utils";
import { ago, bytes, count, duration } from "./format";
import { EntityLinks } from "./EntityLinks";
import { MeterBar, Note, PanelEmpty, PanelSection, Row, Rows, Tiles } from "./Panel";

/**
 * EVERY BOX, FROM INSIDE IT — over ssh, as the account's own user.
 *
 * THREE FIGURES THAT LOOK ADDABLE AND ARE NOT, and this panel keeps all three
 * apart because the server does:
 *
 *   MEMORY ADDS. A byte of RAM on one box and a byte on another are two bytes
 *   being paid for, so there is a fleet total and it means something.
 *
 *   DISK DOES NOT. Filesystems share pools — a Mac's `/` and its Data volume
 *   report the same free space out of one APFS container — so adding mounts
 *   puts a terabyte and a half of free space on a one-terabyte disk. What is
 *   true is per mount, and the fullest one is the figure a fleet page is for.
 *
 *   LOAD DOES NOT. 4.0 is idle on sixteen cores and a fire on one, so the only
 *   comparable figure is load per cpu, and the only fleet-wide statement is how
 *   many boxes are working harder than they have cores for.
 *
 * COUNTERS ARE THE OWNER'S OWN COMMANDS, typed on this page, run on every box.
 * The value recorded is the first number the command prints and only if it
 * exits zero — a command that fails or prints nothing is a GAP, never a nought,
 * and a box with no reading says so in words. This is the only place a command
 * is ever sent to a server: no route and no agent action can name one.
 */
export function FleetPanel({ onCollected }: { onCollected?: () => void }) {
  const report = useApi(() => integrations.fleet(24), []);
  const map = useApi(() => integrations.ventureMap(), []);
  const [collecting, setCollecting] = useState(false);

  async function collect() {
    setCollecting(true);
    try {
      await api.collect("fleet");
      report.reload();
      onCollected?.();
    } finally {
      setCollecting(false);
    }
  }

  if (report.error || !report.data) return null;
  const d = report.data;

  if (!d.boxes.length)
    return (
      <PanelEmpty>
        No box is connected. Add one above as <code>user@host</code> — the key
        is optional, and with none ssh uses this machine's own agent and{" "}
        <code>~/.ssh</code> defaults.
      </PanelEmpty>
    );

  const t = d.totals;

  return (
    <PanelSection
      title="What it reads"
      meta={`${t.answering} of ${t.boxes} answering · read ${ago(t.seenAt)}`}
      onCollect={() => void collect()}
      collecting={collecting}
    >
      <Tiles
        items={[
          {
            v: t.memoryBytes ? `${bytes(t.memoryBytes.used)} / ${bytes(t.memoryBytes.total)}` : "—",
            k: "memory used, summed",
          },
          {
            v: t.fullestDisk?.percent === null || !t.fullestDisk ? "—" : `${t.fullestDisk.percent}%`,
            k: t.fullestDisk ? `fullest disk — ${t.fullestDisk.box} ${t.fullestDisk.mount}` : "no disk read",
          },
          {
            v: String(t.load.boxesOverOnePerCpu),
            k: "boxes over one load per cpu",
          },
          { v: String(t.containers), k: "containers running" },
        ]}
      />

      <Rows>
        {d.boxes.map((b, i) => (
          <Row key={b.accountId} first={i === 0}>
            <div className="flex flex-wrap items-center gap-2">
              <ServerIcon
                className={cn(
                  "size-4 shrink-0",
                  b.sample ? "text-ok" : "text-muted-foreground",
                )}
                strokeWidth={1.6}
              />
              <span className="text-[13px] font-medium">{b.label}</span>
              <span className="text-muted-foreground font-mono text-[11.5px]">
                {b.hostname ?? b.target ?? "no address cached yet"}
              </span>
              {b.docker && (
                <Badge variant="secondary" className="hidden sm:inline-flex">
                  <Box className="size-3" strokeWidth={1.8} />
                  {b.docker.installed ? `${b.docker.running} running` : "no docker"}
                </Badge>
              )}
              <span className="text-muted-foreground ml-auto text-[11.5px]">
                up {duration(b.sample?.uptimeSeconds ?? null)} · read {ago(b.okAt)}
              </span>
            </div>

            {b.error && (
              <p className="text-destructive mt-1 text-[11.5px]">{b.error}</p>
            )}

            {b.sample ? (
              <>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <MeterBar
                    meter={b.sample.memory}
                    label="memory"
                    right={
                      b.sample.memory
                        ? `${bytes(b.sample.memory.used)} of ${bytes(b.sample.memoryTotal)}`
                        : undefined
                    }
                  />
                  {b.disks.map((disk) => (
                    <MeterBar
                      key={disk.mount}
                      meter={disk.meter}
                      label={disk.mount}
                      right={
                        disk.meter
                          ? `${bytes(disk.meter.used)} of ${bytes(disk.size)}`
                          : undefined
                      }
                    />
                  ))}
                  {b.sample.swap && (
                    <MeterBar meter={b.sample.swap} label="swap" />
                  )}
                </div>
                <div className="text-muted-foreground mt-1.5 text-[12px] tabular-nums">
                  load {count(b.sample.load.one)} / {count(b.sample.load.five)} /{" "}
                  {count(b.sample.load.fifteen)} ·{" "}
                  {b.sample.loadPerCpu === null
                    ? "core count unknown, so there is no per-cpu figure"
                    : `${b.sample.loadPerCpu} per cpu over ${b.sample.cpus} cores`}
                </div>
              </>
            ) : (
              <p className="text-muted-foreground mt-1 text-[12px]">
                Nothing has been read off this box yet. The credential exists;
                no collection has reached it.
              </p>
            )}

            {!!b.counters.length && (
              <div className="mt-2 flex flex-col gap-0.5">
                {b.counters.map((counter) => (
                  <div
                    key={counter.label}
                    className="flex flex-wrap items-baseline gap-2 text-[12px]"
                  >
                    <span className="text-muted-foreground">{counter.label}</span>
                    <span className="tabular-nums">
                      {counter.latest ? count(counter.latest.value) : "—"}
                    </span>
                    {counter.note && (
                      <span className="text-muted-foreground text-[11.5px]">
                        {counter.note}
                      </span>
                    )}
                    <code className="text-muted-foreground ml-auto truncate font-mono text-[11px]">
                      {counter.command}
                    </code>
                  </div>
                ))}
              </div>
            )}

            {!!b.containers.length && (
              <p className="text-muted-foreground mt-1.5 truncate font-mono text-[11.5px]">
                {b.containers.map((ct) => ct.name).join(" · ")}
              </p>
            )}

            <EntityLinks
              map={map.data}
              plugin="fleet"
              entity={String(b.accountId)}
              label={b.label}
              onLinked={() => map.reload()}
            />
          </Row>
        ))}
      </Rows>

      <Note>{t.diskBytes.note}</Note>
      <Note>{t.load.note}</Note>
      <Note>
        <b className="text-foreground font-medium">Counters are yours.</b> One
        line of “label = shell command” in Settings above, run on EVERY box as
        the account's ssh user. The value is the first number the command prints
        and only when it exits zero — a failure is a gap on the chart, never a
        nought. Nothing else on this box can send a command to a server: no
        route and no agent action can name one.
      </Note>
    </PanelSection>
  );
}
