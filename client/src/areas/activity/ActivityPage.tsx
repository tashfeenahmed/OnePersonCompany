import { useParams } from "react-router-dom";
import { Journal } from "./Journal";
import { SubTabs } from "@/components/TabStrip";
import { PageShell } from "@/components/PageShell";
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
 * a real address somebody can keep. It is `SubTabs` rather than `TabStrip`
 * because TabStrip's tabs are DRAGGABLE into an order the store remembers, and
 * these three have a fixed one: what happened, who arrived, what it cost, in
 * that order because that is the order they are read in.
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
  { key: "infrastructure", to: "/activity/infrastructure", label: "Infrastructure" },
  { key: "journal", to: "/activity/journal", label: "Work journal" },
  { key: "feed", to: "/activity", label: "Activity" },
  { key: "users", to: "/activity/users", label: "Users" },
  { key: "today", to: "/activity/today", label: "Today" },
];

const SUB: Record<string, string> = {
  infrastructure: "Server, container, disk and GPU transitions, timestamped when observed.",
  journal: "A record of your work, one day at a time.",
  feed: "Updates from your connected services in one timeline. Events label estimated dates.",
  users: "Signups and user totals reported by your products.",
  today: "Failed payments, refunds and disputes that may need your attention.",
};

export function ActivityPage() {
  const { tab, product } = useParams();
  const key = tab === "infrastructure" ? "infrastructure" : tab === "journal" ? "journal" : tab === "users" ? "users" : tab === "today" ? "today" : "feed";

  return (
    <PageShell title="Activity" sub={SUB[key]} wide>
      <SubTabs tabs={TABS} activeKey={key} />
      {key === "journal" && <Journal />}
      {key === "infrastructure" && <Feed days={90} onlyKind="infrastructure" />}

      {key === "feed" && <Feed days={FEED_DAYS} />}
      {key === "users" && (product ? <UserProduct product={product} /> : <Users />)}
      {key === "today" && <Today days={LEAKAGE_DAYS} />}
    </PageShell>
  );
}
