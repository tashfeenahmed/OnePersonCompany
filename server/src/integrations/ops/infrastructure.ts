import { accountRow, now } from "../../db.ts";
import { recordInfrastructure, type InfrastructureSample } from "../activity/infrastructure.ts";
import { insightSettings } from "../insights/settings.ts";

export function recordFleetReachability(id: number, ok: boolean, ts = now()) {
  const label = accountRow(id)?.label ?? `Server ${id}`;
  recordInfrastructure([{ key: `fleet:${id}:reachable`, source: "fleet", label, ts, value: ok,
    describe: (_before, after) => after ? "server probe recovered" : "server probe failed" }]);
}
export function recordFleetResources(id: number, ts: string, probe: { docker: boolean | number | null; disks: { mount: string; used: number; avail: number }[]; containers: { name: string }[] }) {
  const label = accountRow(id)?.label ?? `Server ${id}`, settings = insightSettings();
  const observations: InfrastructureSample[] = probe.disks.map(d => {
    const percent = d.used + d.avail > 0 ? d.used / (d.used + d.avail) * 100 : null;
    return { key: `fleet:${id}:disk:${d.mount}`, source: "fleet", label: `${label} · ${d.mount}`, ts, value: percent === null ? null : percent >= settings.diskPercent, basis: String(settings.diskPercent), detail: { percent, threshold: settings.diskPercent }, describe: (_before, after) => after ? `disk crossed ${settings.diskPercent}% used` : `disk returned below ${settings.diskPercent}% used` };
  });
  if (probe.docker) observations.push({ key: `fleet:${id}:containers`, source: "fleet", label, ts, value: [...new Set(probe.containers.map(c => c.name))].sort().join("\n"),
    describe: (before, after) => {
      const a = String(before).split("\n").filter(Boolean), b = String(after).split("\n").filter(Boolean);
      const started = b.filter(n => !a.includes(n)), stopped = a.filter(n => !b.includes(n));
      return [started.length ? `containers started: ${started.join(", ")}` : "", stopped.length ? `containers stopped or removed: ${stopped.join(", ")}` : ""].filter(Boolean).join("; ");
    } });
  recordInfrastructure(observations);
}
