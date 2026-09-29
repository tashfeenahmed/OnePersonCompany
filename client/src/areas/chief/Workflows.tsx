import { useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { CalendarClock, Compass, Brain, History, LayoutGrid, Lightbulb, LineChart, Settings2, Target } from "lucide-react";
import { PageShell, TopBar } from "@/components/PageShell";
import { TabStrip, type Tab } from "@/components/TabStrip";
import { GoalsTab } from "./GoalsTab";
import { MemoryTab } from "./MemoryTab";
import { OutcomesTab } from "./OutcomesTab";
import { RoundsTab } from "./RoundsTab";
/* The pipeline lives in its own area directory and is reached from here rather
   than from a rail row of its own: it answers the same question this page
   already exists to answer — what the estate does when nobody is looking —
   only one level up from the rounds, which are now one of its stages. */
import { OverviewTab } from "@/areas/pipeline/OverviewTab";
import { RunsTab } from "@/areas/pipeline/RunsTab";
import { EditorTab } from "@/areas/pipeline/EditorTab";
import { ProposalsTab } from "@/areas/pipeline/ProposalsTab";
/* The URL-level half of "did that work": outcomes reads a field in a document,
   this reads one page in Search Console. Same question, different address, so
   it is a tab here rather than a rail row of its own. */
import { SeoFollowUpsTab } from "@/areas/seoops/SeoFollowUpsTab";

/**
 * THE CHIEF OF STAFF'S OWN PAGE.
 *
 * FOUR TABS AND ONE RAIL ROW, not four rail rows. Rounds, goals, memory and
 * outcomes are one feature read at four moments: what the estate does on its
 * own, what you are trying to do, what the assistant knows, and whether any of
 * it worked. Four rows would make each of them look like a category, which is
 * the mistake the Apps rail row was already corrected for.
 *
 * A TAB IS AN ADDRESS, the rule every other tabbed page here follows:
 * /workflows/goals is a place you can send somebody, refresh into, and reach
 * with the back button. The bare /workflows lands on the Overview.
 *
 * THE NIGHTLY WORKFLOW IS FOUR TABS, read in the order somebody asks about it:
 * how is it doing (Overview), what did each run do (Runs), how do I change it
 * (Steps & schedule), and what did it propose (Proposals). The old
 * /workflows/pipeline address lands on the Overview.
 */

const TABS: { key: string; label: string; icon: typeof Compass }[] = [
  { key: "overview", label: "Overview", icon: LayoutGrid },
  { key: "runs", label: "Runs", icon: History },
  { key: "editor", label: "Steps & schedule", icon: Settings2 },
  { key: "proposals", label: "Proposals", icon: Lightbulb },
  { key: "rounds", label: "Venture rounds", icon: CalendarClock },
  { key: "goals", label: "Goals", icon: Target },
  { key: "memory", label: "Memory", icon: Brain },
  { key: "outcomes", label: "Outcomes", icon: Compass },
  { key: "seo", label: "SEO follow-ups", icon: LineChart },
];

const SUB: Record<string, string> = {
  overview: "Everything that runs on its own: how it is doing, when it runs next, and what needs you.",
  runs: "Every run of the nightly workflow, step by step.",
  editor: "When the nightly workflow runs and what its steps do.",
  proposals: "The next actions the workflow proposed for each venture — and the ones its checks refused.",
  rounds: "An older once-a-day walk that hands jobs to sub-agents, and every job it decided not to do.",
  goals: "What you are trying to do — read into every conversation, and into every scheduled brief.",
  memory: "What the assistant knows about you, dated, and yours to correct.",
  outcomes: "Whether a thing you did moved a number. Correlation, never cause.",
  seo: "Whether a page you changed moved in Search Console. A page absent from a report is unmeasured, never zero.",
};

export function Workflows() {
  const { tab } = useParams();
  /* The order is the owner's, the same as the Apps and Dashboards strips. It
     is local rather than in the store because four tabs is not a list somebody
     curates across devices, and a migration for it would cost more than it
     saves. */
  const [order, setOrder] = useState(TABS.map((t) => t.key));

  if (!tab || !TABS.some((t) => t.key === tab)) return <Navigate to="/workflows/overview" replace />;

  const tabs: Tab[] = order
    .map((k) => TABS.find((t) => t.key === k))
    .filter((t): t is (typeof TABS)[number] => !!t)
    .map((t) => ({ key: t.key, to: `/workflows/${t.key}`, label: t.label, icon: t.icon }));

  return (
    <>
      <TopBar label="Workflows" />
      <PageShell title="Workflows" sub={SUB[tab]} wide>
        <TabStrip tabs={tabs} activeKey={tab} onReorder={setOrder} showOnMobile className="mb-5" />
        {tab === "overview" && <OverviewTab />}
        {tab === "runs" && <RunsTab />}
        {tab === "editor" && <EditorTab />}
        {tab === "proposals" && <ProposalsTab />}
        {tab === "rounds" && <RoundsTab />}
        {tab === "goals" && <GoalsTab />}
        {tab === "memory" && <MemoryTab />}
        {tab === "outcomes" && <OutcomesTab />}
        {tab === "seo" && <SeoFollowUpsTab />}
      </PageShell>
    </>
  );
}
