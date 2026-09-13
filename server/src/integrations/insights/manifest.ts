import type { IntegrationManifest } from "../manifest.ts";
import { insightRoutes } from "./routes.ts";
export const manifest: IntegrationManifest = {
  id: "insights",
  routes: [{ path: "/api/insights", app: insightRoutes }],
  skills: [{ id: "insights", title: "Workspace insights", plugins: [],
    asks: ["Which ventures are dormant?", "What changed unusually and where are we heading at this pace?"],
    about: "Data-driven pace projections, dormant ventures and automatic anomaly detection from connected daily series.",
    rules: ["Null means unavailable. Projections assume the recent trend continues; they are not revenue promises.", "Currencies are separate. Dormancy is a grouping of measured activity, never a change to the venture's stage.", "Automatic anomalies compare complete days with a robust baseline; they share alert recovery history."],
    views: [{ key: "default", path: "/api/insights", about: "Sources, projections, dormancy and anomaly evidence.", params: [] }] }],
  packs: { insights: { name: "Workspace insights", category: "operations" } },
};
