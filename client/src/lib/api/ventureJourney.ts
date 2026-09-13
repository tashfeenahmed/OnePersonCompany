import { call } from "@/lib/api";
import type { JourneyCommand, JourneyDocument, JourneyTask, TaskProgress } from "../../../../shared/ventureJourney";
import type { Pace, Anomaly, MetricSeries } from "../../../../shared/insights";
export type JourneySignals = { asOf: string; series: { source: Omit<MetricSeries, "points">; pace: Pace; anomaly: Anomaly }[]; links: { plugin: string; label: string | null; entity: string }[]; notes: string[] };
const root = (id: string) => `/venture-journey/${encodeURIComponent(id)}`;
export const journeyApi = {
  read: (id: string) => call<JourneyDocument>(root(id)),
  update: (id: string, revision: number, command: JourneyCommand) => call<JourneyDocument>(root(id), { method: "PATCH", body: JSON.stringify({ revision, command }) }),
  signals: (id: string) => call<JourneySignals>(`${root(id)}/signals`),
  review: (id: string, review: number) => call<{ tasks: JourneyTask[]; progress: Record<string, TaskProgress> }>(`${root(id)}/reviews/${review}`),
};
