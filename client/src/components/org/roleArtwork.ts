/** Keyed by role, never venture or worker ID: the same job keeps its identity. */
export const ROLE_ARTWORK: Record<string, string> = {
  researcher: "agents/researcher",
  competitors: "agents/competitors",
  seo: "agents/seo",
  demand: "modules/chat",
  visibility: "modules/autopilot",
  writer: "agents/writer",
  producer: "modules/video",
  serp: "agents/serp",
  aso: "agents/aso",
  campaigns: "modules/publishing",
  people: "modules/people",
  "chief-of-staff": "modules/org",
};

/** An older client can still draw a role introduced by a newer server. */
export const FALLBACK_ROLE_ARTWORK = "modules/workflows";
