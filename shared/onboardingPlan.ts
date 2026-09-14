import { businessTypesOf } from "./businessTypes.ts";
import type { BusinessType, JourneyStage } from "./ventureJourney.ts";
import type { ConnectionResult } from "./onboarding.ts";
export type SetupCapability = {
  label: string;
  dashboard: string;
  widgets: string[];
  types?: BusinessType[];
  workspaceOnly?: boolean;
};
export const SETUP_CAPABILITIES: Record<string, SetupCapability> = {
  payments: {
    workspaceOnly: true,
    label: "Payments",
    dashboard: "revenue",
    widgets: ["stripe.net30", "stripe.gross", "stripe.declines"],
  },
  subscriptions: {
    workspaceOnly: true,
    label: "Subscriptions",
    dashboard: "revenue",
    widgets: ["stripe.mrr", "stripe.subs", "stripe.churn"],
    types: ["web", "mobile", "desktop", "service"],
  },
  apple: {
    workspaceOnly: true,
    label: "App Store performance",
    dashboard: "apps",
    widgets: ["appstore.installs", "appstore.proceeds", "appstore.store"],
    types: ["mobile", "desktop"],
  },
  google: {
    workspaceOnly: true,
    label: "Google Play performance",
    dashboard: "apps",
    widgets: ["play.installs", "play.revenue", "play.rating"],
    types: ["mobile"],
  },
  ads: {
    workspaceOnly: true,
    label: "Ad earnings",
    dashboard: "revenue",
    widgets: ["adsense.earnings"],
    types: ["web", "website"],
  },
  traffic: {
    label: "Traffic & visitors",
    dashboard: "analytics",
    widgets: ["umami.pageviews", "umami.visitors", "umami.daily"],
    types: ["web", "website"],
  },
  search: {
    label: "Search performance",
    dashboard: "analytics",
    widgets: ["gsc.clicks", "gsc.impressions", "gsc.queries"],
    types: ["web", "website"],
  },
  bing: {
    label: "Bing search",
    dashboard: "analytics",
    widgets: ["bing.clicks", "bing.impressions"],
    types: ["web", "website"],
  },
  cloudflare: {
    label: "Domains & traffic",
    dashboard: "domains",
    widgets: ["cf.zones", "cf.requests"],
    types: ["web", "website"],
  },
  domains: {
    label: "Domain renewals",
    dashboard: "domains",
    widgets: ["registrars.total", "registrars.expiring"],
    workspaceOnly: true,
  },
  servers: {
    label: "Servers & costs",
    dashboard: "servers",
    widgets: [
      "hetzner.serverCount",
      "hetzner.spend",
      "hetzner.load",
      "hetzner.servers",
    ],
    workspaceOnly: true,
  },
  fleet: {
    label: "Server health",
    dashboard: "servers",
    widgets: ["fleet.memory", "fleet.disk", "fleet.containers", "fleet.table"],
    workspaceOnly: true,
  },
  github: {
    label: "Repositories & releases",
    dashboard: "development",
    widgets: ["github.stars", "github.repos"],
    types: ["web", "mobile", "desktop"],
  },
  openaiUsage: {
    label: "OpenAI usage",
    dashboard: "ai-usage",
    widgets: ["openai.cost", "openai.daily"],
    workspaceOnly: true,
  },
  openrouterUsage: {
    label: "OpenRouter usage",
    dashboard: "ai-usage",
    widgets: ["openrouter.credits", "openrouter.spend", "openrouter.daily"],
    workspaceOnly: true,
  },
  chat: {
    label: "Language models",
    dashboard: "",
    widgets: [],
    workspaceOnly: true,
  },
  runtime: {
    label: "Agent connection",
    dashboard: "",
    widgets: [],
    workspaceOnly: true,
  },
  research: {
    label: "Market research",
    dashboard: "",
    widgets: [],
    workspaceOnly: true,
  },
  media: {
    label: "Media tools",
    dashboard: "",
    widgets: [],
    workspaceOnly: true,
  },
  communication: {
    label: "Communication tools",
    dashboard: "",
    widgets: [],
    workspaceOnly: true,
  },
  customers: {
    workspaceOnly: true,
    label: "Customer activity",
    dashboard: "customers",
    widgets: ["users.total", "users.new"],
    types: ["web", "mobile", "desktop", "service"],
  },
  business: {
    label: "Business metrics",
    dashboard: "business",
    widgets: ["products.metrics", "products.endpoints"],
  },
  social: {
    label: "Audience & advertising",
    dashboard: "analytics",
    widgets: [],
  },
};
export const SERVICE_CAPABILITIES: Record<string, string[]> = {
  stripe: ["payments", "subscriptions"],
  appstore: ["apple"],
  playstore: ["google"],
  adsense: ["ads"],
  umami: ["traffic"],
  gsc: ["search"],
  "bing-webmaster": ["bing"],
  cloudflare: ["cloudflare"],
  dynadot: ["domains"],
  spaceship: ["domains"],
  hetzner: ["servers"],
  fleet: ["fleet"],
  github: ["github"],
  openai: ["chat", "openaiUsage"],
  openrouter: ["chat", "openrouterUsage"],
  local: ["chat"],
  freellmapi: ["chat"],
  hermes: ["runtime"],
  openclaw: ["runtime"],
  searxng: ["research"],
  reddit: ["research"],
  pexels: ["media"],
  pixabay: ["media"],
  replicate: ["media"],
  gmail: ["communication"],
  calendar: ["communication"],
  resend: ["communication"],
  telegram: ["communication"],
  users: ["customers"],
  "product-stats": ["business"],
  meta: ["social"],
};
export const DASHBOARD_LABELS: Record<string, string> = {
  business: "Business metrics",
  overview: "Overview",
  revenue: "Revenue",
  analytics: "Analytics",
  apps: "Apps",
  servers: "Servers",
  domains: "Domains",
  development: "Development",
  "ai-usage": "AI usage",
  customers: "Customers",
};
export type SetupBoard = {
  id: string;
  slug: string;
  name: string;
  ventureId?: string;
  widgets: { id: string; type: string; w: 1 | 2 | 4 }[];
};
export type PlanVenture = {
  id: string;
  slug: string;
  name: string;
  businessType: BusinessType | null;
  businessTypes?: BusinessType[];
  stage: JourneyStage;
  host: string | null;
};
export type PlanLink = { ventureId: string; plugin: string; entity: string };
/** All integrations remain workspace-wide. Venture cards require a resource link and a compatible type. */
export function planDashboards(
  connections: ConnectionResult[],
  ventures: PlanVenture[],
  links: PlanLink[],
  exclude: string[] = [],
): SetupBoard[] {
  const available = connections.filter(
    (c) => c.status === "connected" || c.status === "limited",
  );
  const groups = new Map<string, Set<string>>();
  groups.set("overview", new Set(["overview.attention", "overview.shots"]));
  for (const c of available)
    for (const cap of c.capabilities) {
      const rule = SETUP_CAPABILITIES[cap];
      if (!rule?.dashboard || !rule.widgets.length) continue;
      const group = groups.get(rule.dashboard) ?? new Set<string>();
      rule.widgets.forEach((w) => group.add(w));
      groups.set(rule.dashboard, group);
      rule.widgets.slice(0, 1).forEach((w) => groups.get("overview")!.add(w));
    }
  const boards: SetupBoard[] = [...groups]
    .filter(([key]) => key === "overview" || !exclude.includes(key))
    .map(([key, widgets]) => ({
      id: `setup-${key}`,
      slug: key,
      name: DASHBOARD_LABELS[key] ?? key,
      widgets: [...widgets].map((type, i) => ({
        id: `setup-${key}-${i}`,
        type,
        w: 2,
      })),
    }));
  for (const v of ventures) {
    if (v.stage !== "launched") continue;
    const widgets = new Set<string>();
    for (const c of available) {
      if (!links.some((l) => l.ventureId === v.id && l.plugin === c.plugin))
        continue;
      for (const cap of c.capabilities) {
        const rule = SETUP_CAPABILITIES[cap];
        if (
          !rule ||
          rule.workspaceOnly ||
          !businessTypesOf(v).length ||
          (rule.types &&
            !businessTypesOf(v).some((type) => rule.types!.includes(type)))
        )
          continue;
        rule.widgets.forEach((w) => widgets.add(w));
      }
    }
    if (widgets.size)
      boards.push({
        id: `setup-venture-${v.id}`,
        slug: "overview",
        name: "Overview",
        ventureId: v.id,
        widgets: [...widgets].map((type, i) => ({
          id: `setup-${v.id}-${i}`,
          type,
          w: 2,
        })),
      });
  }
  return boards;
}
