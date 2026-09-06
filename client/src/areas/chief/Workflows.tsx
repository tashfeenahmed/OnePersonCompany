import { useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { CalendarClock, Compass, Brain, Target } from "lucide-react";
import { PageShell, TopBar } from "@/components/PageShell";
import { TabStrip, type Tab } from "@/components/TabStrip";
import { GoalsTab } from "./GoalsTab";
import { MemoryTab } from "./MemoryTab";
import { OutcomesTab } from "./OutcomesTab";
import { RoundsTab } from "./RoundsTab";

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
 * with the back button. The bare /workflows lands on Rounds, which is the one
 * that answers "what happened while I was asleep".
 */

const TABS: { key: string; label: string; icon: typeof Compass }[] = [
  { key: "rounds", label: "Rounds", icon: CalendarClock },
  { key: "goals", label: "Goals", icon: Target },
  { key: "memory", label: "Memory", icon: Brain },
  { key: "outcomes", label: "Outcomes", icon: Compass },
];

const SUB: Record<string, string> = {
  rounds: "What the estate does on its own, and every job it decided not to do.",
  goals: "What you are trying to do — read into every conversation, and into every scheduled brief.",
  memory: "What the assistant knows about you, dated, and yours to correct.",
  outcomes: "Whether a thing you did moved a number. Correlation, never cause.",
};

export function Workflows() {
  const { tab } = useParams();
  /* The order is the owner's, the same as the Apps and Dashboards strips. It
     is local rather than in the store because four tabs is not a list somebody
     curates across devices, and a migration for it would cost more than it
     saves. */
  const [order, setOrder] = useState(TABS.map((t) => t.key));

  if (!tab) return <Navigate to="/workflows/rounds" replace />;
  if (!TABS.some((t) => t.key === tab)) return <Navigate to="/workflows/rounds" replace />;

  const tabs: Tab[] = order
    .map((k) => TABS.find((t) => t.key === k))
    .filter((t): t is (typeof TABS)[number] => !!t)
    .map((t) => ({ key: t.key, to: `/workflows/${t.key}`, label: t.label, icon: t.icon }));

  return (
    <>
      <TopBar label="Workflows" />
      <PageShell title="Workflows" sub={SUB[tab]} wide>
        <TabStrip tabs={tabs} activeKey={tab} onReorder={setOrder} className="mb-5" />
        {tab === "rounds" && <RoundsTab />}
        {tab === "goals" && <GoalsTab />}
        {tab === "memory" && <MemoryTab />}
        {tab === "outcomes" && <OutcomesTab />}
      </PageShell>
    </>
  );
}
