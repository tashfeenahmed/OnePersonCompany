import type { RunDoc } from "./api";

/** Who a workflow step is: its name, its kind, and the sub-agent role if any. */
export type StepInfo = { id: string; title: string; kind: string | null; role: string | null; area?: string | null };

/** Where the thing a step produced can be read. */
export const KIND_OUTPUT: Record<string, { label: string; to: string }> = {
  collect: { label: "Connected sources", to: "/integrations" },
  alerts: { label: "Alerts", to: "/alerts" },
  triage: { label: "Mail", to: "/mail" },
  synthesis: { label: "Proposals", to: "/workflows/proposals" },
  board: { label: "Board", to: "/board" },
  "seo-ops": { label: "SEO follow-ups", to: "/workflows/seo" },
  relationships: { label: "Contacts", to: "/mail/contacts" },
  memory: { label: "Memory", to: "/workflows/memory" },
  briefing: { label: "Morning brief", to: "/alerts/briefing" },
};

export function stepInfoFrom(doc: RunDoc, fallback: (id: string) => StepInfo | undefined): (id: string) => StepInfo {
  return (id) => {
    const snap = doc.workflowSnapshot?.find((b) => b.id === id);
    const known = fallback(id);
    return {
      id,
      title: snap?.title ?? known?.title ?? id,
      kind: snap?.definition?.kind ?? known?.kind ?? null,
      role: snap?.definition?.agent?.role ?? known?.role ?? null,
      area: known?.area ?? null,
    };
  };
}

