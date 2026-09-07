import { useState } from "react";
import { Link } from "react-router-dom";
import { Check, FileText, X } from "lucide-react";
import { ago, day, money } from "@/lib/format";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import {
  customersApi,
  type CaseKind,
  type RecoveryCase,
} from "@/lib/api/customers";
import { Empty, Notes, Problem, Stats } from "./Customers";

/**
 * THE QUEUE — read top to bottom, soonest deadline first.
 *
 * THE ONE PIECE OF EMPHASIS ON THIS PAGE IS A DEADLINE THAT HAS PASSED, and it
 * is emphasis rather than alarm: a date in the past is a fact about the row.
 * Nothing else here is coloured. A cancellation scheduled for October is still
 * billing today, a trial ending on Friday may well convert, and painting
 * either of them red would be the page deciding something the figures do not.
 *
 * A CASE WITH NO DEADLINE SAYS SO IN WORDS rather than showing a blank. "No
 * deadline — it has already ended" and "waiting on a date" are different
 * states, and the row prints the server's own `deadlineIs` sentence.
 *
 * THE ADDRESS IS DRAWN ONLY WHEN THE SERVER SENT ONE. Where it did not, the
 * page prints the server's `contact.why` — it does not compose its own
 * explanation, because the reason is a policy and the policy lives on the
 * server.
 */

const KINDS: { key: CaseKind | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "churn", label: "Cancellations" },
  { key: "payment_failed", label: "Failing payments" },
  { key: "trial_ending", label: "Trials ending" },
  { key: "dispute", label: "Disputes" },
];

const KIND_LABEL: Record<CaseKind, string> = {
  churn: "cancellation",
  payment_failed: "payment failed",
  dispute: "dispute",
  trial_ending: "trial ending",
};

function deadlineText(c: RecoveryCase): string {
  if (!c.deadline) return "No deadline";
  /* UTC, because the server counted `daysLeft` against the UTC day and a page
     that read it locally would say "in 1d" beside yesterday's date. */
  const d = day(c.deadline, { year: true, utc: true });
  if (c.daysLeft === null) return d;
  if (c.daysLeft < 0) return `${d} · ${Math.abs(c.daysLeft)}d ago`;
  if (c.daysLeft === 0) return `${d} · today`;
  return `${d} · in ${c.daysLeft}d`;
}

function title(c: RecoveryCase): string {
  const ctx = c.context ?? {};
  const product = typeof ctx.product === "string" ? ctx.product : null;
  const plan = typeof ctx.plan === "string" ? ctx.plan : null;
  const number = typeof ctx.invoiceNumber === "string" ? ctx.invoiceNumber : null;
  return product ?? plan ?? (number ? `Invoice ${number}` : c.subject);
}

export function RecoveryQueueTab({ tick, onChanged }: { tick: number; onChanged: () => void }) {
  const [kind, setKind] = useState<CaseKind | "all">("all");
  const [showResolved, setShowResolved] = useState(false);
  const q = useApi(
    () =>
      customersApi.queue({
        kind: kind === "all" ? undefined : kind,
        status: showResolved ? "all" : undefined,
        limit: 200,
      }),
    [kind, showResolved, tick],
  );

  const d = q.data;
  const stats: [string, string][] = [
    [d ? String(d.counts.open) : "—", "open"],
    [d ? String(d.counts.drafted) : "—", "drafted"],
    [d ? String(d.counts.overdue) : "—", "past their deadline"],
    [ago(d?.lastPass.at), "last read from Stripe"],
  ];

  return (
    <>
      <Stats items={stats} />

      {d && !d.lastPass.ok && d.lastPass.at && (
        <div className="border-line-soft mb-4 rounded-[14px] border px-3.5 py-2.5 text-[13.5px]">
          <span className="text-destructive">The last pass failed.</span>{" "}
          <span className="text-muted-foreground">
            {d.lastPass.error ?? "No reason was recorded."} This list is as complete as the
            last pass that worked, not as complete as Stripe.
          </span>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-0.5">
        {KINDS.map((k) => (
          <button
            key={k.key}
            onClick={() => setKind(k.key)}
            className={cn(
              "text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg px-2.5 py-1.5 text-[13.5px]",
              kind === k.key && "bg-accent text-foreground font-medium",
            )}
          >
            {k.label}
            {d && k.key !== "all" ? (
              <span className="ml-1.5 tabular-nums opacity-60">{d.counts.byKind[k.key] ?? 0}</span>
            ) : null}
          </button>
        ))}
        <button
          onClick={() => setShowResolved((v) => !v)}
          className={cn(
            "text-muted-foreground hover:bg-accent hover:text-foreground ml-auto rounded-lg px-2.5 py-1.5 text-[13.5px]",
            showResolved && "bg-accent text-foreground font-medium",
          )}
        >
          Include closed
        </button>
      </div>

      {q.error && <Problem error={q.error} />}
      {!q.error && d && d.items.length === 0 && (
        <Empty>
          Nothing is in the queue.{" "}
          {d.lastPass.at
            ? `Stripe was last read ${ago(d.lastPass.at)}.`
            : "Stripe has not been read yet — press Collect on the Customers integration."}
        </Empty>
      )}

      <div className="space-y-1.5">
        {d?.items.map((c) => (
          <CaseRow key={c.id} c={c} contactAccess={d.contactAccess} onChanged={onChanged} />
        ))}
      </div>

      {d && <Notes title="What this list will not tell you" lines={d.cannot} />}
    </>
  );
}

function CaseRow({
  c,
  contactAccess,
  onChanged,
}: {
  c: RecoveryCase;
  contactAccess: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const overdue = c.daysLeft !== null && c.daysLeft < 0;
  const closed = c.status === "resolved" || c.status === "dismissed";
  const cash = c.amount === null ? null : money(c.amount, c.currency ?? "");

  const act = (fn: () => Promise<unknown>) => {
    setBusy(true);
    setSaid(null);
    void fn()
      .then(() => setSaid(null))
      .catch((e: unknown) => setSaid(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(false);
        onChanged();
      });
  };

  return (
    <div className={cn("bg-card rounded-[14px] px-4.5 py-3.5", closed &&"opacity-60")}>
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="text-muted-foreground text-[12.5px]">{KIND_LABEL[c.kind]}</span>
        {/* THE NOUN A PERSON WOULD RECOGNISE, in the order they would: what
            was sold, then what it was priced as, then the invoice's own
            number, and only then Stripe's opaque object id. */}
        <span className="text-[14.5px]">{title(c)}</span>
        {c.ventureName && (
          <span className="text-muted-foreground text-[12.5px]">· {c.ventureName}</span>
        )}
        {cash && <span className="text-[14px] tabular-nums">{cash}</span>}
        <span
          className={cn(
            "ml-auto text-[13.5px] tabular-nums",
            overdue ? "text-foreground font-medium" : "text-muted-foreground",
          )}
        >
          {deadlineText(c)}
        </span>
      </div>

      <div className="text-muted-foreground mt-1 text-[12.5px]">
        {c.deadlineIs ?? "no deadline recorded"}
        {c.status !== "open" && <> · {c.status}</>}
        {c.outboxId && (
          <>
            {" "}
            ·{" "}
            <Link to="/mail/outbox" className="underline underline-offset-2">
              draft #{c.outboxId} in the Outbox
            </Link>
          </>
        )}
      </div>

      {c.resolution && (
        <div className="text-muted-foreground mt-1 text-[13px] italic">{c.resolution}</div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg px-2 py-1 text-[12.5px]"
        >
          {open ? "Hide facts" : "Facts"}
        </button>
        {!closed && c.kind !== "dispute" && (
          <button
            disabled={busy || Boolean(c.outboxId) || !contactAccess || !c.contact.address}
            onClick={() => act(() => customersApi.prepare(c.id))}
            title={
              c.contact.address
                ? "Write a follow-up into the Outbox as a draft"
                : c.contact.why
            }
            className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] disabled:opacity-40"
          >
            <FileText className="size-3.5" strokeWidth={1.6} /> Prepare draft
          </button>
        )}
        {!closed && (
          <>
            <button
              disabled={busy}
              onClick={() => act(() => customersApi.resolve(c.id, "Closed from the Customers page."))}
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] disabled:opacity-40"
            >
              <Check className="size-3.5" strokeWidth={1.6} /> Resolve
            </button>
            <button
              disabled={busy}
              onClick={() => act(() => customersApi.dismiss(c.id, "Dismissed from the Customers page."))}
              title="Permanent — the pass never re-opens a dismissed case"
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12.5px] disabled:opacity-40"
            >
              <X className="size-3.5" strokeWidth={1.6} /> Dismiss
            </button>
          </>
        )}
        <span className="text-muted-foreground ml-auto text-[12.5px]">
          {c.contact.address ?? (c.contact.known ? `${c.contact.domain ?? "address"} · hidden` : "no address")}
        </span>
      </div>

      {said && <div className="text-destructive mt-2 text-[12.5px]">{said}</div>}

      {open && (
        <div className="border-line-soft mt-2.5 border-t pt-2.5">
          <div className="text-muted-foreground mb-1.5 text-[12.5px]">{c.contact.why}</div>
          <pre className="text-muted-foreground overflow-x-auto text-[12.5px] leading-relaxed">
            {JSON.stringify(c.context, null, 1)}
          </pre>
        </div>
      )}
    </div>
  );
}
