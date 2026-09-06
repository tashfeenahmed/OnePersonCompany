import { Link, useParams } from "react-router-dom";
import { PageShell } from "@/components/PageShell";
import { cn } from "@/lib/utils";
import { Feed } from "./Feed";
import { Users } from "./Users";
import { UserProduct } from "./UserProduct";
import { Today } from "./Today";

/**
 * ACTIVITY — one rail row, three tabs, and they are three tabs rather than
 * three rail rows on purpose.
 *
 * They are the same question at three distances. Activity is what happened.
 * Users is who arrived. Today is what it cost. A reader who opens one of them
 * usually wants the next, and three rows in the rail would have made three
 * separate errands out of one.
 *
 * THE URL IS THE SELECTION, the way Apps and Dashboards do it — /activity,
 * /activity/users, /activity/users/<product>, /activity/today — so every tab is
 * a real address somebody can keep. The strip is written out here rather than
 * reusing TabStrip because TabStrip's tabs are DRAGGABLE into an order the
 * store remembers, and these three have a fixed one: what happened, who
 * arrived, what it cost, in that order because that is the order they are read
 * in.
 *
 * THE WINDOW IS FIXED PER TAB rather than being a control. The feed's fourteen
 * days is "the last fortnight", the leakage window's thirty is the one every
 * payment processor reports in, and a picker here would be a decision on a page
 * whose job is to remove one. The routes take a `days` parameter for anybody
 * who wants another.
 */

const FEED_DAYS = 14;
const LEAKAGE_DAYS = 30;

const TABS = [
  { key: "feed", to: "/activity", label: "Activity" },
  { key: "users", to: "/activity/users", label: "Users" },
  { key: "today", to: "/activity/today", label: "Today" },
];

const SUB: Record<string, string> = {
  feed: "Updates from your connected services in one timeline. Events label estimated dates.",
  users: "Signups and user totals reported by your products.",
  today: "Failed payments, refunds and disputes that may need your attention.",
};

export function ActivityPage() {
  const { tab, product } = useParams();
  const key = tab === "users" ? "users" : tab === "today" ? "today" : "feed";

  return (
    <PageShell title="Activity" sub={SUB[key]} wide>
      <div className="mb-5 flex items-center gap-0.5 overflow-x-auto">
        {TABS.map((t) => (
          <Link
            key={t.key}
            to={t.to}
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

      {key === "feed" && <Feed days={FEED_DAYS} />}
      {key === "users" && (product ? <UserProduct product={product} /> : <Users />)}
      {key === "today" && <Today days={LEAKAGE_DAYS} />}
    </PageShell>
  );
}
