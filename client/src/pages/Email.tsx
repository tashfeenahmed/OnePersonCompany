import { Suspense, lazy, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { Handshake, Inbox, Newspaper, PenLine, Send, Sparkles, Sprout, Users } from "lucide-react";
import { EmbeddedPages } from "@/components/PageShell";
import { SubTabs, type SubTab } from "@/components/TabStrip";
import { mailflowApi } from "@/lib/api/mailflow";
import { peopleApi } from "@/lib/api/people";

const Mailbox = lazy(() => import("@/pages/Mailbox").then(m => ({ default: m.Mailbox })));
const Triage = lazy(() => import("@/areas/mailflow/Triage").then(m => ({ default: m.Triage })));
const Outbox = lazy(() => import("@/areas/mailflow/Outbox").then(m => ({ default: m.Outbox })));
const Nurture = lazy(() => import("@/areas/nurture/Nurture").then(m => ({ default: m.Nurture })));
const Commitments = lazy(() => import("@/areas/people/Commitments").then(m => ({ default: m.Commitments })));
const Contacts = lazy(() => import("@/areas/people/Contacts").then(m => ({ default: m.Contacts })));
const Brief = lazy(() => import("@/areas/people/Brief").then(m => ({ default: m.Brief })));

/**
 * EMAIL — one page, one header, eight tabs, each named for what it does and
 * carrying a one-line purpose under the strip.
 *
 * The URL keys are the old ones (/mail/triage, /mail/outbox, /mail/commitments,
 * /mail/contacts, /mail/stale, /mail/brief, /mail/nurture) so every existing
 * link — the action inbox writes /mail/email?thread=… — still lands. Only the
 * words on the tabs changed. "Gone quiet" (/mail/stale) is a filter inside the
 * People tab rather than a tab of its own.
 *
 * Badges count what needs the owner: threads that need a reply, drafts
 * waiting for an OK, promises still open. They are re-read whenever the tab
 * changes, and every minute while the page is open.
 */
type Counts = { priority?: number; drafts?: number; promises?: number };

type MailTab = SubTab & { purpose: string; badge?: keyof Counts };

const TABS: MailTab[] = [
  { key: "inbox", to: "/mail/inbox", label: "Inbox", icon: Inbox, purpose: "Every email that arrived, newest first. Click one to read and reply." },
  { key: "triage", to: "/mail/triage", label: "Priority", icon: Sparkles, badge: "priority", purpose: "Your recent mail sorted for you — answer what needs a reply, clear the rest." },
  { key: "outbox", to: "/mail/outbox", label: "Drafts", icon: PenLine, badge: "drafts", purpose: "Emails written for you. Nothing sends until you approve it." },
  { key: "commitments", to: "/mail/commitments", label: "Promises", icon: Handshake, badge: "promises", purpose: "Things you said you'd do, found in your sent mail. Tick them off when done." },
  { key: "contacts", to: "/mail/contacts", label: "People", icon: Users, purpose: "Who you email with, and who has gone quiet." },
  { key: "brief", to: "/mail/brief", label: "Weekly note", icon: Newspaper, purpose: "A short weekly summary of who you've been in touch with." },
  { key: "sent", to: "/mail/sent", label: "Sent by apps", icon: Send, purpose: "Automatic emails your products sent — sign-ups, receipts — and whether they arrived." },
  { key: "nurture", to: "/mail/nurture", label: "Follow-ups", icon: Sprout, purpose: "Automatic follow-up email series. Each email waits in Drafts for your OK." },
];

/** Which tab a URL segment belongs to. /mail/stale is the People tab. */
function tabFor(segment: string): string {
  if (segment === "stale") return "contacts";
  return TABS.some(t => t.key === segment) ? segment : "inbox";
}

function useMailCounts(tab: string): Counts {
  const [counts, setCounts] = useState<Counts>({});
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    let live = true;
    void Promise.allSettled([
      mailflowApi.triage(),
      mailflowApi.outbox(null, 0, 1),
      peopleApi.commitments({ status: "open", limit: 1 }),
    ]).then(([triage, outbox, promises]) => {
      if (!live) return;
      setCounts({
        priority: triage.status === "fulfilled" ? triage.value.counts.needsReply : undefined,
        drafts:
          outbox.status === "fulfilled"
            ? outbox.value.counts.draft +
              outbox.value.counts.approved +
              outbox.value.counts.failed +
              (outbox.value.counts.uncertain ?? 0)
            : undefined,
        promises: promises.status === "fulfilled" ? promises.value.counts.open : undefined,
      });
    });
    return () => {
      live = false;
    };
  }, [tab, tick]);
  return counts;
}

export function Email() {
  const { pathname } = useLocation();
  /* WHICH TAB IS READ OFF THE ADDRESS, never held in state: /mail/triage is a
     place somebody sends a link to. */
  const segment = pathname.replace(/^\/mail\/?/, "").split("/")[0] ?? "";
  const tab = tabFor(segment);
  const active = TABS.find(t => t.key === tab) ?? TABS[0]!;
  const counts = useMailCounts(tab);

  const strip: SubTab[] = TABS.map(({ purpose, badge, ...t }) => ({
    ...t,
    title: purpose,
    count: badge && counts[badge] ? counts[badge] : undefined,
    countPill: true,
  }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-line-soft shrink-0 border-b px-3 pt-4 pb-2 sm:px-4.5">
        <div className="px-1 sm:px-2.5">
          <h1 className="text-[21px] font-normal tracking-[-0.025em]">Email</h1>
        </div>
        <SubTabs tabs={strip} activeKey={tab} className="mt-2 mb-0" />
        <p className="text-muted-foreground mt-1.5 px-1 text-[13px] leading-snug sm:px-2.5" aria-live="polite">
          {active.purpose}
        </p>
      </header>

      <EmbeddedPages>
        <Suspense fallback={<p role="status" className="text-muted-foreground p-6 text-[13.5px]">Loading…</p>}>
          <Routes>
            <Route index element={<LegacyMailbox />} />
            <Route path="inbox" element={<Mailbox mode="inbox" />} />
            <Route path="sent" element={<Mailbox mode="sent" />} />
            <Route path="triage" element={<Triage />} />
            <Route path="commitments" element={<Commitments />} />
            {/* One component for People and its "Gone quiet" filter. */}
            <Route path="contacts" element={<Contacts stale={false} />} />
            <Route path="stale" element={<Contacts stale />} />
            <Route path="brief" element={<Brief />} />
            <Route path="outbox" element={<Outbox />} />
            <Route path="nurture" element={<Nurture />} />
            {/* The old mailbox address: /mail/email?mode=sent&thread=… — the
                action inbox still writes these (server/src/routes/actionInbox.ts). */}
            <Route path="email" element={<LegacyMailbox />} />
            <Route path="*" element={<Navigate to="/mail/inbox" replace />} />
          </Routes>
        </Suspense>
      </EmbeddedPages>
    </div>
  );
}

/** The old mailbox address: `?mode=sent` is the Sent by apps tab, everything
 *  else is the Inbox, and every other parameter (the open thread, the account,
 *  the mailbox chip) is carried across untouched. */
function LegacyMailbox() {
  const location = useLocation();
  const [params] = useSearchParams();
  const rest = new URLSearchParams(params);
  const sent = rest.get("mode") === "sent";
  rest.delete("mode");
  const search = rest.toString();
  return (
    <Navigate
      to={`/mail/${sent ? "sent" : "inbox"}${search ? `?${search}` : ""}${location.hash}`}
      state={location.state}
      replace
    />
  );
}
