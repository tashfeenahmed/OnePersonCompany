import { Suspense, lazy } from "react";
import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { Clock, Inbox, ListChecks, Newspaper, Send, SendHorizontal, Sprout, SquareCheck, Users } from "lucide-react";
import { EmbeddedPages } from "@/components/PageShell";
import { SubTabs, type SubTab } from "@/components/TabStrip";

const Mailbox = lazy(() => import("@/pages/Mailbox").then(m => ({ default: m.Mailbox })));
const Triage = lazy(() => import("@/areas/mailflow/Triage").then(m => ({ default: m.Triage })));
const Outbox = lazy(() => import("@/areas/mailflow/Outbox").then(m => ({ default: m.Outbox })));
const Nurture = lazy(() => import("@/areas/nurture/Nurture").then(m => ({ default: m.Nurture })));
const Commitments = lazy(() => import("@/areas/people/Commitments").then(m => ({ default: m.Commitments })));
const Contacts = lazy(() => import("@/areas/people/Contacts").then(m => ({ default: m.Contacts })));
const Brief = lazy(() => import("@/areas/people/Brief").then(m => ({ default: m.Brief })));

/**
 * EMAIL — one page, one header, nine tabs.
 *
 * WHAT IT REPLACES. The sidebar carried four mail rows (Email, Triage,
 * Outbox, Nurture), each drawn under the slim strip that named it, and the
 * rest of the mailbox's questions lived somewhere else entirely: "Sent by
 * apps" was a mode inside the mailbox, and People was a page of its own with
 * four tabs — Contacts, Stale, Brief, Commitments — every one of them a
 * question about mail. Nine views of the same mailbox, reached three
 * different ways. They are nine tabs of one page now: the header says Email
 * and which of the nine you are reading, and the sidebar has one mail row.
 *
 * THE TABS, IN THE ORDER MAIL MOVES, WITH THE PEOPLE IN THE MIDDLE: what
 * arrived (Inbox), what the apps sent (Sent by apps), what needs an answer
 * (Triage), what was promised in an answer (Commitments), who the answers go
 * to (Contacts), who has stopped getting them (Stale), what changed about all
 * of that this week (Brief), what is written and waiting (Outbox), and what
 * will be written on a schedule (Nurture). The three people tabs sit after
 * Commitments because that is where the subject turns from a message to the
 * person at the other end of it, and before the Outbox because what is queued
 * is a message again. Nurture is last rather than absent: it is the only other
 * mail page there is, and a page nothing links to is a page nobody finds.
 *
 * NO TOP BAR, the same call the Studio made (see App.tsx): this header already
 * says where you are, and the strip above it would push the whole page down by
 * its height to say it again in smaller type.
 *
 * THE HEADER DOES NOT SCROLL AND THE PAGES DO. Each embedded page brings its
 * own scrolling box — PageShell's for seven of them, the mailbox's two panes
 * for the other two — so this component's job is a column that gives them the
 * rest of the height and nothing else.
 *
 * THE EMBEDDED PAGES DRAW NO TITLE OF THEIR OWN. What does it is
 * `EmbeddedPages` below, which PageShell reads — see components/PageShell.tsx.
 * Triage in particular is mounted exactly as it is at its own address.
 */
const TABS: SubTab[] = [
  { key: "inbox", to: "/mail/inbox", label: "Inbox", icon: Inbox },
  { key: "sent", to: "/mail/sent", label: "Sent by apps", icon: Send },
  { key: "triage", to: "/mail/triage", label: "Triage", icon: ListChecks },
  { key: "commitments", to: "/mail/commitments", label: "Commitments", icon: SquareCheck },
  /* THE THREE THAT WERE PEOPLE. Same strip, no divider: nine tabs of one
     subject, and a rule drawn between the fourth and the fifth would say
     there are two pages here after all. */
  { key: "contacts", to: "/mail/contacts", label: "Contacts", icon: Users },
  { key: "stale", to: "/mail/stale", label: "Stale", icon: Clock, title: "Correspondences that have gone quiet." },
  { key: "brief", to: "/mail/brief", label: "Brief", icon: Newspaper, title: "The weekly reading of what changed." },
  { key: "outbox", to: "/mail/outbox", label: "Outbox", icon: SendHorizontal },
  { key: "nurture", to: "/mail/nurture", label: "Nurture", icon: Sprout },
];

export function Email() {
  const { pathname } = useLocation();
  /* WHICH TAB IS READ OFF THE ADDRESS, never held in state: /mail/triage is a
     place somebody sends a link to. The bare /mail redirects to /mail/inbox
     below, so the fallback here is only ever momentary. */
  const segment = pathname.replace(/^\/mail\/?/, "").split("/")[0] ?? "";
  const tab = TABS.some(t => t.key === segment) ? segment : "inbox";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-line-soft shrink-0 border-b px-4.5 pt-4 pb-2">
        <div className="flex items-baseline gap-3 px-2.5">
          <h1 className="text-[21px] font-normal tracking-[-0.025em]">Email</h1>
          <p className="text-muted-foreground truncate text-[13px]">
            Everything the mailbox is: what arrived, what was sent, what is owed, who it is owed
            to and what is queued.
          </p>
        </div>
        <SubTabs tabs={TABS} activeKey={tab} className="mt-2 mb-0" />
      </header>

      {/*
        THE NINE PAGES, AT RELATIVE PATHS, because this component is mounted at
        /mail/* — see App.tsx. Nothing here remounts the header, so switching
        tabs changes the column and leaves the strip alone.
      */}
      <EmbeddedPages>
        <Suspense fallback={<p role="status" className="p-6">Loading page…</p>}>
          <Routes>
            <Route index element={<LegacyMailbox />} />
            <Route path="inbox" element={<Mailbox mode="inbox" />} />
            <Route path="sent" element={<Mailbox mode="sent" />} />
            <Route path="triage" element={<Triage />} />
            <Route path="commitments" element={<Commitments />} />
            {/* One component for two tabs: `stale` is the whole difference —
                see areas/people/Contacts.tsx. */}
            <Route path="contacts" element={<Contacts stale={false} />} />
            <Route path="stale" element={<Contacts stale />} />
            <Route path="brief" element={<Brief />} />
            <Route path="outbox" element={<Outbox />} />
            <Route path="nurture" element={<Nurture />} />
            {/* WHERE THE MAILBOX USED TO BE. /mail/email carried its mode in a
                query parameter, and links to one open thread — the action
                inbox writes them (server/src/routes/actionInbox.ts) — still
                do. Both forms land on the tab that is now the mode. */}
            <Route path="email" element={<LegacyMailbox />} />
            {/* Anything else under /mail is the inbox. */}
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
