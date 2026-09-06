import { useState } from "react";
import { Loader2, Moon, Power, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { ago, count, durationS, pct } from "@/lib/format";
import { PanelEmpty, PanelSection, Row, Rows } from "@/components/integrations/Panel";
import { workstationApi, type WorkstationMachine } from "@/lib/api/security";

/**
 * THE DESK MACHINE — the one panel in this app with a power switch on it.
 *
 * ASLEEP IS NOT AN ERROR AND THIS PANEL NEVER DRAWS IT AS ONE. Every other
 * integration here goes red when the thing it watches stops answering, because
 * a server that is off is an incident. A desktop that is off is a desktop. So
 * an unreachable machine is drawn in the muted colour with the word "asleep",
 * and the destructive colour is kept for a credential that is actually broken.
 *
 * WAKE CANNOT BE CONFIRMED and the panel says so where the button is rather
 * than in a note at the bottom. Nothing acknowledges a magic packet: the only
 * honest report is that it was sent, and the only test is asking again.
 *
 * SLEEP AND SHUTDOWN ARE ONLY DRAWN WHEN A COMMAND HAS BEEN TYPED. A button
 * that is going to answer "no command has been set" is a button that should not
 * be there; where none is set, the panel prints the documented command for each
 * OS so the settings form above has something to be filled in with.
 */
function gpuLine(m: WorkstationMachine): string {
  if (!m.gpus) return m.gpuNote ?? "no GPU reading";
  if (!m.gpus.length) return "nvidia-smi answered with no cards";
  return m.gpus
    .map(
      (g) =>
        `${g.name}${g.utilisationPercent === null ? "" : ` · ${pct(g.utilisationPercent / 100)}`}` +
        `${g.temperatureC === null ? "" : ` · ${g.temperatureC}°C`}` +
        `${g.memoryUsedMb === null || g.memoryTotalMb === null ? "" : ` · ${count(g.memoryUsedMb)}/${count(g.memoryTotalMb)} MB`}`,
    )
    .join(" — ");
}

export function WorkstationPanel({ onCollected }: { onCollected?: () => void }) {
  const doc = useApi(() => workstationApi.get(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function act(key: string, fn: () => Promise<{ note?: string; error?: string | null }>) {
    setBusy(key);
    setProblem(null);
    setSaid(null);
    try {
      const res = await fn();
      setSaid(res.note ?? "Done.");
      if (res.error) setProblem(res.error);
      doc.reload();
      onCollected?.();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  if (doc.error || !doc.data) return null;
  const d = doc.data;

  if (!d.machines.length)
    return (
      <PanelEmpty>
        No machine is connected. One account is one machine: an ssh target, optionally a key, and
        optionally the MAC address of its WIRED adapter — which is the only thing that makes waking
        it possible.
      </PanelEmpty>
    );

  return (
    <PanelSection title="What it reads" meta={`checked live · ${ago(d.machines[0]?.checkedAt)}`}>
      <Rows>
        {d.machines.map((m, i) => (
          <Row key={m.id} first={i === 0}>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13.5px]">
              <span
                className={cn(
                  "size-1.5 shrink-0 translate-y-[-1px] rounded-full",
                  m.reachable ? "bg-ok" : "bg-border",
                )}
              />
              <span className="font-medium">{m.label}</span>
              <span className="text-muted-foreground font-mono text-[12.5px]">{m.target}</span>
              <span className={cn("text-[12.5px]", m.reachable ? "" : "text-muted-foreground")}>
                {m.reachable ? `awake · up ${durationS(m.uptimeS)}` : "asleep or unreachable"}
              </span>
              <span className="text-muted-foreground ml-auto text-[12.5px]">
                {m.mac ? `MAC ${m.mac}` : "no MAC — cannot be woken"}
              </span>
            </div>

            <div className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">
              GPU: {gpuLine(m)}
              {!m.gpus && " — this is not a claim that the machine has no GPU."}
            </div>

            {!m.reachable && m.error && (
              <div className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">{m.error}</div>
            )}

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== null || !m.mac}
                title={m.mac ? "Send a wake-on-LAN magic packet" : "No MAC address on this account"}
                onClick={() => void act(`wake-${m.id}`, () => workstationApi.wake(m.id))}
              >
                {busy === `wake-${m.id}` ? (
                  <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                ) : (
                  <Zap className="size-3.5" strokeWidth={1.8} />
                )}
                Wake
              </Button>
              {d.commands.sleep && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  title={`Runs “${d.commands.sleep}” over ssh`}
                  onClick={() => void act(`sleep-${m.id}`, () => workstationApi.power(m.id, "sleep"))}
                >
                  {busy === `sleep-${m.id}` ? (
                    <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                  ) : (
                    <Moon className="size-3.5" strokeWidth={1.8} />
                  )}
                  Sleep
                </Button>
              )}
              {d.commands.shutdown && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null}
                  title={`Runs “${d.commands.shutdown}” over ssh`}
                  onClick={() =>
                    void act(`shutdown-${m.id}`, () => workstationApi.power(m.id, "shutdown"))
                  }
                >
                  {busy === `shutdown-${m.id}` ? (
                    <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
                  ) : (
                    <Power className="size-3.5" strokeWidth={1.8} />
                  )}
                  Shut down
                </Button>
              )}
              <span className="text-muted-foreground text-[12.5px]">
                Nothing acknowledges a magic packet — after Wake, ask again in half a minute.
              </span>
            </div>

            {m.history.length > 1 && (
              <div className="mt-2 flex flex-wrap gap-[2px]" title="Reachability, one mark per collection">
                {m.history.slice(-96).map((h) => (
                  <span
                    key={h.ts}
                    title={`${h.ts} — ${h.reachable ? "awake" : "asleep"}`}
                    className={cn("h-2.5 w-[3px] rounded-[1px]", h.reachable ? "bg-ok" : "bg-border")}
                  />
                ))}
              </div>
            )}
          </Row>
        ))}
      </Rows>

      {said && <p className="mt-3 text-[13.5px] leading-relaxed">{said}</p>}
      {problem && <p className="text-destructive mt-2 text-[13.5px] leading-relaxed">{problem}</p>}

      {!d.commands.sleep && !d.commands.shutdown && (
        <p className="text-muted-foreground mt-3 text-[12.5px] leading-relaxed">
          No power command is set, so there is no Sleep or Shut down button. Type one in Settings
          above — the documented ones are{" "}
          {Object.entries(d.commands.documented)
            .map(([os, c]) => `${os}: “${c.sleep}” / “${c.shutdown}”`)
            .join(", ")}
          . Check it works in your own terminal first: whether it needs sudo is that machine's own
          policy, and nothing here can know it.
        </p>
      )}

      <p className="text-muted-foreground mt-3 text-[12.5px] leading-relaxed">{d.note}</p>
    </PanelSection>
  );
}
