import { SelectField, SelectOption } from "@/components/ui/select-field";
import { useLocation, Link } from "react-router-dom";
import { useDraft } from "@/hooks/useDraft";
import { useStore } from "@/lib/store";
import { useEffect, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Inbox, Loader2, Pencil, Plus, Send, Trash2, X } from "lucide-react";
import { HostMark } from "@/components/HostMark";
import { ago, day, when } from "@/lib/format";
import { addressDomain, deliveryLabel, mailTime, senderName, type Tone } from "@/lib/mailText";
import { Avatar, EmptyState, FilterChips, Problem, SmallPrint, ToneChip, type FilterChip } from "./parts";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "@/components/Markdown";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import {
  mailflowApi,
  type OutboxDoc,
  type OutboxItem,
  type OutboxStatus,
} from "@/lib/api/mailflow";
import { nurtureApi, type DraftReasons } from "@/lib/api/nurture";

/**
 * THE OUTBOX — mail this box has written, and the two presses that send it.
 *
 * WHY APPROVE AND SEND ARE TWO BUTTONS. They could be one, and one would be a
 * page where the difference between "I have read this" and "this is now in
 * somebody's inbox" is a single click at the end of a scroll. Approving says
 * the words are right; sending says now. The server enforces the same split —
 * `POST /send` refuses anything that is not already approved — so the two
 * buttons are the shape of the rule rather than a UI flourish.
 *
 * THE AGENT CAN REACH THIS QUEUE AND CANNOT REACH THOSE TWO BUTTONS. The
 * `outbox` skill publishes draft, edit and dismiss and no approve and no send;
 * both routes additionally refuse any request carrying the skills proxy's
 * header. A row that says "written by the agent" is a row of words, and words
 * are all it can produce.
 *
 * WHAT IS DRAWN IS `preview`, NOT `body` — the markdown WITH the signature
 * setting under it, which is exactly what the recipient receives. A signature
 * appended invisibly at send time would mean the document approved here is not
 * the document that went out.
 *
 * DISMISSED ROWS STAY ON THE PAGE. They are the queue's memory: the
 * per-address floor counts them, so a dismissal is why nothing will offer to
 * write to that person again for a fortnight, and hiding them would make that
 * refusal look arbitrary when it arrives.
 */

/**
 * THE REASONS BEHIND THE WORDS — the plan, the facts and what the validator
 * said, fetched on demand for the one card the owner opened.
 *
 * WHY IT IS A SEPARATE REQUEST. A fact packet is a dozen rows with a source
 * sentence each; forty of them in the listing would be most of the response and
 * none of it read. The card asks for its own when it is opened, which is the
 * moment somebody actually wants to know where a figure came from.
 *
 * `validation.by === "template"` IS DRAWN AS A WARNING RATHER THAN HIDDEN. It
 * means the model's wording was refused by the fact check — it wrote a number
 * or a date the packet does not carry — and the deterministic wording was used
 * instead. That is the guard working, and a card that concealed it would be a
 * card that made the guard invisible.
 */
function Reasons({ id }: { id: number }) {
  const open = true;
  const [doc, setDoc] = useState<DraftReasons | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || doc) return;
    nurtureApi
      .reasons(id)
      .then(setDoc)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [open, id, doc]);

  return (
    <div>
      {!doc && !error && <p>Loading…</p>}
      {open && error && <p role="alert" className="text-destructive mt-1.5 text-[13px]">{error}</p>}
      {open && doc && (
        <div className="mt-2 space-y-2">
          {doc.plan && (
            <p className="text-muted-foreground text-[12.5px]">
              {doc.plan.whyNow}. From {doc.plan.from} by {doc.plan.via}.
            </p>
          )}
          {doc.validation && (
            <p
              className={cn(
                "text-[12.5px]",
                doc.validation.by === "template" ? "text-warn" : "text-muted-foreground",
              )}
            >
              {doc.validation.by === "model"
                ? `Worded by ${doc.validation.model ?? "the model"}; every number, amount, date, link and address in it appears somewhere in the facts below. Money is checked with its currency; the rest is membership of one pooled set, so this is a floor on fabrication rather than a proof that a figure belongs where it was used.`
                : `The model's wording was NOT used — ${doc.validation.why}. This is the deterministic wording built from the same facts.`}
              {doc.validation.refusals.length > 0 && ` (${doc.validation.refusals.join("; ")})`}
            </p>
          )}
          {doc.facts && doc.facts.length > 0 && (
            <ul className="space-y-1">
              {doc.facts.map((f, i) => (
                <li key={i} className="text-[12.5px]">
                  <span className="font-mono">{f.key}</span>:{" "}
                  <span>{String(f.value)}</span>
                  {f.unit ? ` ${f.unit}` : ""}
                  <span className="text-muted-foreground">
                    {" "}
                    — {f.source}
                    {f.observed_at ? `; observed ${day(f.observed_at)}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {doc.validation && doc.validation.cannotSay.length > 0 && (
            <details>
              <summary className="text-muted-foreground cursor-pointer text-[12.5px]">
                Things the email is not allowed to claim
              </summary>
              <ul className="mt-1 space-y-0.5">
                {doc.validation.cannotSay.map((s, i) => (
                  <li key={i} className="text-muted-foreground text-[12.5px]">{s}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="text-muted-foreground/70 text-[12.5px]">{doc.note}</p>
        </div>
      )}
    </div>
  );
}

/** A row's status, said as what the owner has to do about it. */
function statusLabel(status: OutboxStatus, requireApproval: boolean): { label: string; tone: Tone } {
  switch (status) {
    case "draft":
      return requireApproval ? { label: "Waiting for your OK", tone: "warn" } : { label: "Ready to send", tone: "ok" };
    case "approved":
      return { label: "Approved · ready to send", tone: "ok" };
    case "sending":
      return { label: "Sending…", tone: "muted" };
    case "sent":
      return { label: "Sent", tone: "ok" };
    case "failed":
      return { label: "Didn't send", tone: "bad" };
    case "uncertain":
      return { label: "Check if it sent", tone: "warn" };
    case "dismissed":
      return { label: "Dismissed", tone: "muted" };
    default:
      return { label: status, tone: "muted" };
  }
}

function writtenBy(who: string, sequenceStep: number | null): string {
  if (sequenceStep !== null) return `Follow-up email ${sequenceStep}`;
  if (who === "owner") return "Written by you";
  if (who === "agent") return "Written by AI";
  return `Written by ${who}`;
}

function Card({
  item,
  requireApproval,
  onChanged,
}: {
  item: OutboxItem;
  requireApproval: boolean;
  onChanged: (next: OutboxItem) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [to, setTo, editToError] = useDraft(`opc-outbox-edit:${item.id}:to`, item.to);
  const [subject, setSubject, editSubjectError] = useDraft(`opc-outbox-edit:${item.id}:subject`, item.subject);
  const [body, setBody, editBodyError] = useDraft(`opc-outbox-edit:${item.id}:body`, item.body);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  async function run(fn: () => Promise<{ item: OutboxItem }>) {
    setBusy(true);
    setRefused(null);
    try {
      const res = await fn();
      onChanged(res.item);
      setEditing(false);
    } catch (err) {
      setRefused(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const live = item.status === "draft" || item.status === "approved" || item.status === "failed";
  const status = statusLabel(item.status, requireApproval);
  const fromDomain = addressDomain(item.from);
  const delivery = item.deliveryEvent ? deliveryLabel(item.deliveryEvent) : null;

  return (
    <div className="bg-card border-line-soft mb-3 rounded-xl border p-3.5 sm:p-4.5">
      <div className="flex items-start gap-3">
        <Avatar name={senderName(null, item.to)} address={item.to} size={34} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13.5px]">
              <span className="text-muted-foreground">To </span>
              {item.to}
            </span>
            <span className="text-muted-foreground shrink-0 text-[11.5px] tabular-nums" title={when(item.createdAt)}>
              {mailTime(item.createdAt)}
            </span>
          </div>
          <p className="mt-0.5 text-[14.5px] leading-snug font-medium break-words">{item.subject}</p>
          <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]">
            <ToneChip tone={status.tone}>{status.label}</ToneChip>
            <span className="inline-flex items-center gap-1">
              {fromDomain && <HostMark host={fromDomain} size={13} />}
              From {item.fromName ?? item.from ?? "your mailbox"}
            </span>
            <span>· {writtenBy(item.createdBy, item.sequenceId !== null ? item.sequenceStep : null)}</span>
            {item.ventureName && <span>· {item.ventureName}</span>}
            {item.inReplyTo && (
              <Link className="underline" to={`/mail/inbox?thread=${encodeURIComponent(item.inReplyTo)}&account=${item.accountId}`}>
                See the conversation
              </Link>
            )}
          </div>
        </div>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          {(editToError || editSubjectError || editBodyError) && <p role="alert">{editToError || editSubjectError || editBodyError}</p>}
          <label className="block text-[12.5px]">
            <span className="text-muted-foreground">To</span>
            <Input aria-label="Recipient" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1" />
          </label>
          <label className="block text-[12.5px]">
            <span className="text-muted-foreground">Subject</span>
            <Input aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} className="mt-1" />
          </label>
          <label className="block text-[12.5px]">
            <span className="text-muted-foreground">Message</span>
            <Textarea
              aria-label="Message body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="mt-1 text-[14px]"
            />
          </label>
          {item.status === "approved" && (
            <p className="text-muted-foreground text-[12.5px]">Saving changes means you'll need to approve it again.</p>
          )}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void run(() => mailflowApi.edit(item.id, { to, subject, body }))}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Check />} Save changes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              <X /> Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          {/* `preview`, not `body`: the signature is part of what goes out, so
              it is part of what is read before approving. */}
          <div className="border-line-soft mt-3 max-h-[420px] overflow-y-auto rounded-lg border px-3 py-2 text-[14px]">
            <Markdown text={item.preview} />
          </div>

          {item.fromError && (
            <p role="alert" className="text-destructive mt-2 text-[13px]">
              Can't be sent as it is: {item.fromError}
            </p>
          )}
          {!item.fromError && item.fromWarning && (
            <p className="text-warn mt-2 text-[13px]">{item.fromWarning}</p>
          )}
          {item.error && (
            <p role="alert" className="text-destructive mt-2 text-[13px]">{item.error}</p>
          )}
          {item.status === "sent" && (
            <p className="text-muted-foreground mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px]">
              Sent {mailTime(item.sentAt)} through {item.sentVia === "resend" ? "Resend" : "Gmail"}
              {delivery && <ToneChip tone={delivery.tone}>{delivery.label}</ToneChip>}
            </p>
          )}
          {refused && <p role="alert" className="text-destructive mt-2 text-[13px]">{refused}</p>}

          {item.status === "uncertain" && (
            <div className="border-warn/40 bg-warn/5 mt-3 rounded-lg border p-3 text-[13px]">
              <p>We couldn't confirm this sent. Look in Gmail's Sent folder first so it isn't sent twice.</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button size="sm" variant="outline" asChild>
                  <a href="https://mail.google.com/mail/u/0/#sent" target="_blank" rel="noreferrer">Open Gmail Sent</a>
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => {
                  if (confirm("Have you checked the correct Gmail account's Sent folder and confirmed this exact message was NOT sent? Unlocking it permits another delivery attempt.")) void run(() => mailflowApi.resolve(item.id));
                }}>It didn't send — let me retry</Button>
              </div>
            </div>
          )}
          {live && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {item.status !== "approved" && requireApproval && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => mailflowApi.approve(item.id, item.approvalKey))}
                  title="Say it's right. You'll send it with one more press."
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Check />} Approve
                </Button>
              )}
              {(item.status === "approved" || !requireApproval) && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => mailflowApi.send(item.id, item.approvalKey))}
                >
                  {busy ? <Loader2 className="animate-spin" /> : <Send />} Send now
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={busy}>
                <Pencil /> Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => mailflowApi.dismiss(item.id))}
                title="Don't send it"
              >
                <Trash2 /> Dismiss
              </Button>
            </div>
          )}

          {(item.hasReasons || item.messageId || item.via) && (
            <SmallPrint summary={item.hasReasons ? "Why this email was written" : "Details"} className="mt-3">
              {item.via && <p>Leaves through {item.via === "resend" ? "Resend" : "Gmail"}.</p>}
              {item.messageId && (
                <p>
                  Message id <span className="font-mono">{item.messageId}</span>
                </p>
              )}
              {item.sentVia === "resend" && !item.deliveryEvent && item.status === "sent" && (
                <p>No delivery update from Resend yet — that doesn't mean it wasn't delivered.</p>
              )}
              {item.deliveryEvent && item.deliveryReadAt && <p>Delivery checked {ago(item.deliveryReadAt)}.</p>}
              {item.hasReasons && <Reasons id={item.id} />}
            </SmallPrint>
          )}
        </>
      )}
    </div>
  );
}

/** The owner writing one by hand. The same route the agent uses, from the
 *  other side — which is why a manual draft is a draft too and waits like the
 *  rest. */
type ReplyDraft = { to?: string; subject?: string; account?: number; thread?: string; venture?: string; back?: string };
function Composer({ accounts, onCreated }: { accounts: OutboxDoc["accounts"]; onCreated: (item: OutboxItem) => void }) {
  const location = useLocation();
  const reply = (location.state as { reply?: ReplyDraft } | null)?.reply;
  const { state } = useStore();
  const key = `opc-outbox-compose:${reply?.account ?? "new"}:${reply?.thread ?? "new"}`;
  const [to, setTo, toError] = useDraft(`${key}:to`, reply?.to ?? "");
  const [subject, setSubject, subjectError] = useDraft(`${key}:subject`, reply?.subject ?? "");
  const [body, setBody, bodyError] = useDraft(`${key}:body`);
  const [account, setAccount] = useDraft(`${key}:account`, String(reply?.account ?? accounts[0]?.id ?? ""));
  const [venture, setVenture] = useDraft(`${key}:venture`, reply?.venture ?? "");
  const [open, setOpen] = useState(!!reply || !!to || !!subject || !!body);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => { if (reply) setOpen(true); }, [key]);
  if (!open) return <Button size="sm" onClick={() => setOpen(true)}><Plus />New email</Button>;
  return <section className="bg-card border-line-soft mb-5 space-y-3 rounded-xl border p-4 sm:p-5">
    <div className="flex flex-wrap items-baseline gap-2">
      <h2 className="text-[15px] font-medium">{reply?.thread ? "Reply" : "New email"}</h2>
      {reply?.back && <Link className="text-muted-foreground text-[12.5px] underline" to={reply.back}>Back to the conversation</Link>}
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-[12.5px]"><span className="text-muted-foreground">From</span><SelectField aria-label="From account" value={account} disabled={!!reply?.thread} onValueChange={(value) => setAccount(value)} className="mt-1 flex w-full rounded border p-2">
        <SelectOption value="">Choose a Gmail account</SelectOption>{accounts.map(a => <SelectOption key={a.id} value={a.id}>{a.address ?? a.label}</SelectOption>)}
      </SelectField></label>
      <label className="block text-[12.5px]"><span className="text-muted-foreground">To</span><Input className="mt-1" value={to} type="email" onChange={e => setTo(e.target.value)} /></label>
    </div>
    <label className="block text-[12.5px]"><span className="text-muted-foreground">Subject</span><Input className="mt-1" value={subject} maxLength={300} onChange={e => setSubject(e.target.value)} /></label>
    <label className="block text-[12.5px]"><span className="text-muted-foreground">Message</span><Textarea className="mt-1 text-[14px]" value={body} maxLength={20000} rows={8} onChange={e => setBody(e.target.value)} /></label>
    <label className="block text-[12.5px]"><span className="text-muted-foreground">Venture (optional)</span><SelectField value={venture} onValueChange={(value) => setVenture(value)} className="mt-1 flex w-full rounded border p-2"><SelectOption value="">No venture</SelectOption>{state.ventures.map(v => <SelectOption key={v.id} value={v.id}>{v.name}</SelectOption>)}</SelectField></label>
    {(error || toError || subjectError || bodyError) && <p role="alert" className="text-destructive text-sm">{error || toError || subjectError || bodyError}</p>}
    <div className="flex flex-wrap items-center gap-2"><Button disabled={busy || !account || !to.trim() || !subject.trim() || !body.trim()} onClick={async () => {
      setBusy(true); setError(null);
      try { const result = await mailflowApi.draft({ to, subject, body, account: Number(account), venture: venture || null, inReplyTo: reply?.thread }); onCreated(result.item); setTo(""); setSubject(""); setBody(""); setOpen(false); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); }
    }}>{busy ? <Loader2 className="animate-spin" /> : <Check />}Save as draft</Button><Button variant="ghost" onClick={() => setOpen(false)}>Close (keeps what you typed)</Button></div>
    <p className="text-muted-foreground text-[12px]">It's saved to the list below, where you approve and send it.</p>
  </section>;
}

type Filter = OutboxStatus | "all";

export function Outbox() {
  const [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<Filter>("draft");
  const doc = useApi<OutboxDoc>(
    () => mailflowApi.outbox(tab === "all" ? null : tab, offset),
    [tab, offset],
  );

  const d = doc.data;

  function replace(next: OutboxItem) {
    doc.setData((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((i) => (i.id === next.id ? next : i)),
          }
        : prev,
    );
    /* A status change moves the row between filters, so the counts are re-read. */
    doc.reload();
  }

  const requireApproval = d?.settings.requireApproval ?? true;
  const c = d?.counts;
  const chips: FilterChip<Filter>[] = [
    { key: "draft", label: requireApproval ? "Waiting for OK" : "Ready to send", count: c?.draft, urgent: true },
    ...(requireApproval ? [{ key: "approved" as Filter, label: "Approved", count: c?.approved, urgent: true }] : []),
    ...(["failed", "uncertain", "sending"] as const)
      .filter((k) => (c?.[k] ?? 0) > 0 || tab === k)
      .map((k) => ({
        key: k as Filter,
        label: k === "failed" ? "Didn't send" : k === "uncertain" ? "Check if sent" : "Sending",
        count: c?.[k],
        urgent: k !== "sending",
      })),
    { key: "sent", label: "Sent", count: c?.sent },
    { key: "dismissed", label: "Dismissed", count: c?.dismissed },
    { key: "all", label: "All" },
  ];

  const { limit, total } = d?.pagination ?? { limit: 50, total: 0 };

  return (
    <PageShell
      title="Drafts"
      sub="Emails written for you. Nothing sends until you approve it."
      wide
    >
      {d && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
          <Composer accounts={d.accounts} onCreated={() => { setOffset(0); setTab("draft"); doc.reload(); }} />
          <span className="text-muted-foreground text-[12.5px]">
            {d.today.sent} of {d.today.cap} sent today
          </span>
        </div>
      )}

      <FilterChips
        label="Show"
        chips={chips}
        value={tab}
        onChange={(k) => {
          setTab(k);
          setOffset(0);
        }}
        className="mb-4"
      />

      {doc.error && <Problem className="mb-4">Couldn't load your drafts: {doc.error}</Problem>}

      {doc.loading && !d && (
        <p className="text-muted-foreground text-[14px]">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
          Loading…
        </p>
      )}

      {d && d.items.length === 0 && (
        <EmptyState
          icon={tab === "draft" || tab === "approved" ? Check : Inbox}
          title={tab === "draft" || tab === "approved" ? "Nothing waiting for you" : "Nothing here"}
          body={
            tab === "draft"
              ? "When you reply to an email or AI writes a follow-up, it waits here for your OK."
              : "Pick another filter above, or write a new email."
          }
        />
      )}

      {d?.items.map((item) => (
        <Card
          key={item.id}
          item={item}
          requireApproval={d.settings.requireApproval}
          onChanged={replace}
        />
      ))}

      {d && total > limit && (
        <div className="text-muted-foreground mt-2 flex items-center gap-2 text-[12.5px]">
          <Button size="sm" variant="ghost" disabled={offset === 0 || doc.loading} onClick={() => setOffset((n) => Math.max(0, n - limit))}>
            <ChevronLeft /> Newer
          </Button>
          <span className="tabular-nums">
            {offset + 1}–{offset + d.items.length} of {total}
          </span>
          <Button size="sm" variant="ghost" disabled={offset + d.items.length >= total || doc.loading} onClick={() => setOffset((n) => n + limit)}>
            Older <ChevronRight />
          </Button>
        </div>
      )}

      {d && (
        <SmallPrint summary="Sending rules" className="mt-8">
          <p>Sends from {d.mailbox.address ?? "no mailbox yet — connect Gmail under Integrations"}.</p>
          <p>
            At most {d.today.cap} emails a day
            {d.settings.gapDays > 0 ? `, and one email per person every ${d.settings.gapDays} days (dismissed ones count too)` : ""}.
          </p>
          <p>
            {d.settings.requireApproval
              ? "Every email needs your Approve, then Send now. AI can write drafts but can never send."
              : "Approval is off — Send now sends straight away. AI still can't send."}
          </p>
          <p>{d.note}</p>
        </SmallPrint>
      )}
    </PageShell>
  );
}
