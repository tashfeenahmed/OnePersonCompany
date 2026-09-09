import { Suspense, lazy } from "react";
import { Navigate, Route, Routes, useLocation, useSearchParams } from "react-router-dom";
import { Inbox, ListChecks, Send, SendHorizontal, Sprout, SquareCheck } from "lucide-react";
import { EmbeddedPages } from "@/components/PageShell";
import { SubTabs, type SubTab } from "@/components/TabStrip";

const Mailbox = lazy(() => import("@/pages/Mailbox").then(m => ({ default: m.Mailbox })));
const Triage = lazy(() => import("@/areas/mailflow/Triage").then(m => ({ default: m.Triage })));
const Outbox = lazy(() => import("@/areas/mailflow/Outbox").then(m => ({ default: m.Outbox })));
const Nurture = lazy(() => import("@/areas/nurture/Nurture").then(m => ({ default: m.Nurture })));
const Commitments = lazy(() => import("@/areas/people/Commitments").then(m => ({ default: m.Commitments })));

/**
 * EMAIL — one page, one header, six tabs.
 *
 * WHAT IT REPLACES. The sidebar carried four mail rows (Email, Triage,
 * Outbox, Nurture), each drawn under the slim strip that named it, and two
 * more mail questions lived somewhere else entirely: "Sent by apps" was a
 * mode inside the mailbox, and Commitments was the fourth tab of People. Six
 * views of the same mailbox, reached six different ways. They are six tabs of
 * one page now — the header says Email and which of the six you are reading,
 * and the sidebar has one mail row.
 *
 * THE TABS, IN THE ORDER MAIL MOVES: what arrived (Inbox), what the apps sent
 * (Sent by apps), what needs an answer (Triage), what was promised in an
 * answer (Commitments), what is written and waiting (Outbox), and what will be
 * written on a schedule (Nurture). Nurture is last rather than absent: it is
 * the only other mail page there is, and a page nothing links to is a page
 * nobody finds.
 *
 * NO TOP BAR, the same call the Studio made (see App.tsx): this header already
 * says where you are, and the strip above it would push the whole page down by
 * its height to say it again in smaller type.
 *
 * THE HEADER DOES NOT SCROLL AND THE PAGES DO. Each embedded page brings its
 * own scrolling box — PageShell's for four of them, the mailbox's two panes
 * for the other two — so this component's job is a column that gives them the
 * rest of the height and nothing else.
 *
 * THE EMBEDDED PAGES DRAW NO TITLE OF THEIR OWN. They are untouched: what
 * changes is `EmbeddedPages` below, which PageShell reads — see
 * components/PageShell.tsx. Triage in particular is mounted exactly as it is
 * at its own address.
 */
const TABS: SubTab[] = [
  { key: "inbox", to: "/mail/inbox", label: "Inbox", icon: Inbox },
  { key: "sent", to: "/mail/sent", label: "Sent by apps", icon: Send },
  { key: "triage", to: "/mail/triage", label: "Triage", icon: ListChecks },
  { key: "commitments", to: "/mail/commitments", label: "Commitments", icon: SquareCheck },
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
            Everything the mailbox is: what arrived, what was sent, what is owed and what is queued.
          </p>
        </div>
        <SubTabs tabs={TABS} activeKey={tab} className="mt-2 mb-0" />
      </header>

      {/*
        THE SIX PAGES, AT RELATIVE PATHS, because this component is mounted at
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
