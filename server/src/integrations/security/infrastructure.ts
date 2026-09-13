import { recordInfrastructure, type InfrastructureSample } from "../activity/infrastructure.ts";
import { insightSettings } from "../insights/settings.ts";

export function recordWorkstationObservation(s: { id: number; label: string; reachable: boolean; gpus: { name: string; utilisationPercent: number | null }[] | null }, ts: string) {
  const threshold = insightSettings().gpuBusyPercent;
  const samples: InfrastructureSample[] = [{ key: `workstation:${s.id}:reachable`, source: "workstation", label: s.label, ts, value: s.reachable,
    describe: (_before, after) => after ? "workstation became reachable" : "workstation became unreachable" }];
  if (s.reachable) for (const [i, gpu] of (s.gpus ?? []).entries()) samples.push({ key: `workstation:${s.id}:gpu:${i}:${gpu.name}`, source: "workstation", label: `${s.label} · ${gpu.name}`, ts,
    value: gpu.utilisationPercent === null ? null : gpu.utilisationPercent >= threshold, basis: String(threshold), detail: { utilization: gpu.utilisationPercent, threshold },
    describe: (_before, after) => after ? `GPU became busy (≥${threshold}%)` : `GPU became idle (<${threshold}%)` });
  recordInfrastructure(samples);
}
