import { useState } from "react";
import { useParams } from "react-router-dom";
import { SubTabs } from "@/components/TabStrip";
import { PanelEmpty, Tiles } from "@/components/integrations/Panel";
import { PageShell } from "@/components/PageShell";
import { RecoveryQueueTab } from "./RecoveryQueue";
import { DisputesTab } from "./Disputes";
import { EventsTab } from "./Events";

/**
 * CUSTOMERS — one rail row, three tabs, and they are three tabs rather than
 * three rows for the reason Activity's are: they are the same question at
 * three distances.
 *
 * Recovery is who is about to leave and by when. Disputes is who has already
 * gone to their bank. Events is what happened in the last few hours, and
 * whether anybody was told. A reader who opens one of them usually wants the
 * next, and three rail rows would have made three errands out of one morning.
 *
 * THE URL IS THE SELECTION — /customers, /customers/disputes, /customers/events
 * — so every tab is a real address somebody can keep.
 *
 * WHAT THIS PAGE REFUSES TO DO. It does not colour a case red. A deadline is a
 * date, not a verdict: a cancellation scheduled for October is still billing
 * today and drawing it as a loss would be this page making a judgement the
 * figures do not support. The only thing it emphasises is a deadline that has
 * already PASSED, which is a fact rather than an opinion.
 */

const TABS = [
  { key: "queue", to: "/customers", label: "Recovery queue" },
  { key: "disputes", to: "/customers/disputes", label: "Disputes" },
  { key: "events", to: "/customers/events", label: "Events" },
];

const SUB: Record<string, string> = {
  queue:
    "Cancellations, failing invoices and trials about to end, sorted by the date something runs out. Preparing a follow-up writes a draft into the Outbox; nothing here can send it.",
  disputes:
    "Chargebacks as cases rather than as ledger debits: open, won, lost, and the bank's evidence deadline. The ledger's dispute money is shown beside them as a cross-check and is never added to them.",
  events:
    "Stripe's own event feed, one row per event id, with why each one did or did not become a message.",
};

export function Customers() {
  const { tab } = useParams();
  const key = tab === "disputes" ? "disputes" : tab === "events" ? "events" : "queue";
  const [tick, setTick] = useState(0);
  const reload = () => setTick((n) => n + 1);

  return (
    <PageShell title="Customers" sub={SUB[key]} wide>
      <SubTabs tabs={TABS} activeKey={key} rule />

      {key === "queue" && <RecoveryQueueTab tick={tick} onChanged={reload} />}
      {key === "disputes" && <DisputesTab />}
      {key === "events" && <EventsTab tick={tick} onChanged={reload} />}
    </PageShell>
  );
}

/* --------------------------------------------------------------- shared bits */

/** The stat strip every tab opens with, as pairs. Values are STRINGS so a
 *  figure that was not measured can be an em dash rather than a zero — the
 *  three tabs format their own before they get here. */
export function Stats({ items }: { items: [string, string][] }) {
  return <Tiles items={items.map(([v, k]) => ({ v, k }))} />;
}

/** The sentences a document says about itself — what it will not answer, and
 *  why a figure is shaped the way it is. Drawn rather than dropped, because
 *  the refusals are the product. */
export function Notes({ title, lines }: { title: string; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <div className="border-line-soft mt-6 rounded-[14px] border px-3.5 py-3">
      <div className="text-muted-foreground mb-1.5 text-[12.5px] font-medium">{title}</div>
      <ul className="text-muted-foreground space-y-1 text-[13.5px] leading-relaxed">
        {lines.map((l) => (
          <li key={l}>· {l}</li>
        ))}
      </ul>
    </div>
  );
}

/** "Nothing yet", INSIDE the page rather than in place of it — so the box
 *  holds the space the list would have taken and the page does not jump when
 *  the first row arrives. */
export function Empty({ children }: { children: React.ReactNode }) {
  return <PanelEmpty boxed>{children}</PanelEmpty>;
}

export function Problem({ error }: { error: string }) {
  return (
    <div className="text-destructive border-line-soft rounded-[14px] border px-3.5 py-3 text-[14px]">
      {error}
    </div>
  );
}
