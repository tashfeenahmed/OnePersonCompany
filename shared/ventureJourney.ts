import { JOURNEY_TEMPLATES } from "./ventureJourneyTemplates.ts";
export const BUSINESS_TYPES = [
  { id: "web", label: "Web app" }, { id: "mobile", label: "Mobile app" },
  { id: "desktop", label: "Desktop app" }, { id: "website", label: "Website" },
  { id: "shop", label: "Local shop" }, { id: "goods", label: "Physical goods" },
  { id: "service", label: "Services / other" },
] as const;
export const businessLabel = (type: BusinessType | null) => BUSINESS_TYPES.find(t => t.id === type)?.label ?? "Choose a business type";
export type BusinessType = typeof BUSINESS_TYPES[number]["id"];
export const JOURNEY_STAGES = ["idea", "pre-launch", "launched"] as const;
export type JourneyStage = typeof JOURNEY_STAGES[number];
export const STAGE_LABELS: Record<JourneyStage, string> = { idea: "Idea", "pre-launch": "Pre-launch", launched: "Launched" };
export const isBusinessType = (v: unknown): v is BusinessType => BUSINESS_TYPES.some(t => t.id === v);
export const isJourneyStage = (v: unknown): v is JourneyStage => JOURNEY_STAGES.some(s => s === v);
export const PROFILE_FIELDS = {
  customer: "First customer", problem: "Problem to solve", promise: "Smallest useful promise",
  revenueModel: "Offer & pricing assumptions", experiment: "Next experiment", successMeasure: "What would count as evidence?",
  launchDate: "Target launch date", launchAudience: "First audience & channel", firstWeek: "First-week plan",
  weeklyFocus: "This week's priority", reviewDate: "Next review date", decision: "Decision & why",
} as const;
export type JourneyProfile = Partial<Record<keyof typeof PROFILE_FIELDS, string>>;
export type TaskStatus = "todo" | "done" | "skipped";
export type TaskProgress = { status: TaskStatus; evidence: string; updatedAt: string };
export type JourneyTask = { key: string; stage: JourneyStage; businessType: BusinessType | null; title: string; detail: string; evidenceHint: string; tool: string; group: string; required: boolean; custom?: boolean };
export type NameCandidate = { id: string; name: string; domain: string; status: "unchecked" | "shortlisted" | "ruled-out" | "chosen"; evidence: string; updatedAt: string };
export type JourneyState = { version: 1; profile: JourneyProfile; tasks: Record<string, TaskProgress>; custom: JourneyTask[]; names: NameCandidate[] };
export type StageChange = { id: number; fromStage: JourneyStage; toStage: JourneyStage; note: string; at: string };
export type JourneyDocument = { ventureId: string; stage: JourneyStage; businessType: BusinessType | null; revision: number; updatedAt: string | null; state: JourneyState; history: StageChange[]; reviews: { id: number; at: string; businessType: BusinessType | null; done: number; total: number }[] };
export type JourneyCommand =
  | { kind: "profile"; values: JourneyProfile }
  | { kind: "task"; key: string; status: TaskStatus; evidence: string }
  | { kind: "add-task"; stage: JourneyStage; businessType: BusinessType | null; title: string; detail: string; required: boolean }
  | { kind: "delete-task"; key: string }
  | { kind: "name"; id?: string; name: string; domain: string; status: NameCandidate["status"]; evidence: string }
  | { kind: "delete-name"; id: string }
  | { kind: "start-review"; businessType: BusinessType | null };
export function emptyJourney(): JourneyState { return { version: 1, profile: {}, tasks: {}, custom: [], names: [] }; }
export function journeyTasks(state: JourneyState, stage: JourneyStage, businessType: BusinessType | null) {
  return [...JOURNEY_TEMPLATES, ...state.custom].filter(t => t.stage === stage && (t.businessType === null || t.businessType === businessType));
}
export function journeyReadiness(tasks: JourneyTask[], progress: JourneyState["tasks"]) {
  const done = tasks.filter(t => progress[t.key]?.status === "done").length;
  const skipped = tasks.filter(t => progress[t.key]?.status === "skipped").length;
  const open = tasks.filter(t => !progress[t.key] || progress[t.key]!.status === "todo");
  return { total: tasks.length, done, skipped, open, requiredOpen: open.filter(t => t.required), percent: tasks.length ? Math.round(done / tasks.length * 100) : 0 };
}
/** The exported record includes all tracks and stages, not just the visible checklist. */
export function journeyExport(name: string, doc: JourneyDocument) { return { format: "opc-venture-journey", exportedAt: new Date().toISOString(), name, ...doc, templates: JOURNEY_TEMPLATES }; }
