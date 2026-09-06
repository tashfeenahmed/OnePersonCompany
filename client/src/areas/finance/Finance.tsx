import { Link, useParams } from "react-router-dom";
import { PageShell } from "@/components/PageShell";
import { cn } from "@/lib/utils";
import { Ledger } from "./Ledger";
import { Renewals } from "./Renewals";
import { Allocation } from "./Allocation";
import { Pnl } from "./Pnl";
import { Power } from "./Power";

/**
 * FINANCE — one page, five tabs, and they are five tabs rather than five rail
 * rows for the reason Activity's three are: they are one question at five
 * distances. What does it cost, what renews, who carries the shared part, what
 * does each business keep, and what does the machine on the desk draw.
 *
 * THE URL IS THE SELECTION, the rule every tabbed page here follows, so each
 * tab is an address somebody can send.
 *
 * IT IS REACHED FROM DASHBOARDS rather than from a rail row of its own. The
 * cost cards already live on a dashboard called Costs; this is the same
 * subject one level deeper, and a sixteenth row in the rail for it would be a
 * row nobody could find among the fifteen.
 */

const TABS = [
  { key: "ledger", label: "Ledger", sub: "Every recurring cost, per currency. A yearly bill counts as a twelfth a month; a one-off counts as nothing. A price nobody knows is a dash, not a zero." },
  { key: "renewals", label: "Renewals", sub: "What renews next, and what you decided about it. Recording a decision here cancels nothing at the provider." },
  { key: "allocation", label: "Allocation", sub: "How each shared bill is split between ventures. What is left unallocated stays unallocated — nobody's margin carries it." },
  { key: "profit", label: "Profit", sub: "Revenue in, costs out, one row per currency. A closed month is an actual; the month running is a part-month with the projection method named." },
  { key: "power", label: "Power", sub: "What the machine under the desk draws, so local inference is priced beside the providers it undercuts." },
];

export function Finance() {
  const { tab } = useParams();
  const key = TABS.some((t) => t.key === tab) ? tab! : "ledger";
  const current = TABS.find((t) => t.key === key)!;

  return (
    <PageShell title="Finance" sub={current.sub} wide>
      <div className="mb-5 flex items-center gap-0.5 overflow-x-auto">
        {TABS.map((t) => (
          <Link
            key={t.key}
            to={t.key === "ledger" ? "/finance" : `/finance/${t.key}`}
            aria-current={t.key === key ? "page" : undefined}
            className={cn(
              "text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg px-2.5 py-1.5 text-[12.5px] whitespace-nowrap",
              t.key === key && "bg-accent text-foreground font-medium",
            )}
          >
            {t.label}
          </Link>
        ))}
      </div>

      {key === "ledger" && <Ledger />}
      {key === "renewals" && <Renewals />}
      {key === "allocation" && <Allocation />}
      {key === "profit" && <Pnl />}
      {key === "power" && <Power />}
    </PageShell>
  );
}
