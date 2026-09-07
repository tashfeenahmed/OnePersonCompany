import { useLocation, Link } from "react-router-dom";
import { useDraft } from "@/hooks/useDraft";
import { useStore } from "@/lib/store";
import { useEffect, useState } from "react";
import { Check, Loader2, Pencil, Send, Trash2, X } from "lucide-react";
import { SubTabs } from "@/components/TabStrip";
import { day, when } from "@/lib/format";
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

const TABS: { key: OutboxStatus | "all"; label: string }[] = [
  { key: "draft", label: "Drafts" },
  { key: "approved", label: "Approved" },
  { key: "sent", label: "Sent" },
  { key: "dismissed", label: "Dismissed" },
  { key: "failed", label: "Failed" },
  { key: "sending", label: "Sending" },
  { key: "uncertain", label: "Check delivery" },
  { key: "all", label: "Everything" },
];

const STATUS_TONE: Record<string, string> = {
  draft: "text-muted-foreground",
  approved: "text-warn",
  sent: "text-ok",
  dismissed: "text-muted-foreground/70",
  failed: "text-destructive",
};

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
  const [open, setOpen] = useState(false);
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
    <div className="border-line-soft mt-2 rounded-lg border px-3 py-2">
      <button
        className="text-muted-foreground text-[12.5px] underline"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide" : "Show"} the facts this was written from
      </button>
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
                What nothing here measured, so the message must not mention it
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

  return (
    <div className="bg-card border-line-soft mb-3 rounded-xl p-4.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[14.5px] font-medium">{item.subject}</span>
            <span className={cn("text-[12.5px]", STATUS_TONE[item.status])}>
              {item.status}
            </span>
          </div>
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 text-[12.5px]">
            <span>from {item.fromName ?? item.from ?? "unknown mailbox"} → {item.to}</span>
            {item.via && (
              <>
          <span>·</span>
          {/* WHICH DOOR IT LEAVES BY. A product-domain message going out
              through Gmail would land in spam; the card says which
              transport before anybody approves it, not after. */}
          <span className="border-line-soft rounded border px-1 py-px">via {item.via}</span>
              </>
            )}
            <span>·</span>
            <span>written by {item.createdBy}</span>
            {item.sequenceId !== null && (
              <>
                <span>·</span>
                <span>sequence step {item.sequenceStep}</span>
              </>
            )}
            <span>·</span>
            <span>{when(item.createdAt)}</span>
            {item.ventureName && (
              <>
                <span>·</span>
                <span className="border-line-soft rounded border px-1 py-px">
                  {item.ventureName}
                </span>
              </>
            )}
            {item.inReplyTo && (
              <>
                <span>·</span>
                <Link className="underline" to={`/mail/email?thread=${encodeURIComponent(item.inReplyTo)}&account=${item.accountId}`}>Open conversation</Link>
              </>
            )}
          </div>
        </div>
      </div>

      {editing ? (
        <div className="mt-3 space-y-2">
          {(editToError || editSubjectError || editBodyError) && <p role="alert">{editToError || editSubjectError || editBodyError}</p>}
          <Input aria-label="Recipient" value={to} onChange={(e) => setTo(e.target.value)} placeholder="to" />
          <Input
            aria-label="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="subject"
          />
          <Textarea
            aria-label="Message body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            className="text-[14px]"
          />
          <p className="text-muted-foreground text-[12.5px]">
            Markdown. It is sent as plain text exactly as written.
            {item.status === "approved" &&
              " Saving this returns the row to draft — the approval was of the previous wording."}
          </p>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void run(() => mailflowApi.edit(item.id, { to, subject, body }))}
            >
              {busy ? <Loader2 className="animate-spin" /> : <Check />} Save
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
          <div className="border-line-soft mt-3 rounded-lg border px-3 py-2">
            <Markdown text={item.preview} />
          </div>

          {item.hasReasons && <Reasons id={item.id} />}

          {item.fromError && (
            <p role="alert" className="text-destructive mt-2 text-[13.5px]">
              This cannot be sent as written: {item.fromError}
            </p>
          )}
          {/* A WARNING IS NOT A REFUSAL. A domain mid-propagation still drafts
              and still sends; this is the sentence that should reach the owner
              before he approves rather than as a 4xx afterwards. */}
          {!item.fromError && item.fromWarning && (
            <p className="text-warn mt-2 text-[13.5px]">{item.fromWarning}</p>
          )}
          {item.error && (
            <p role="alert" className="text-destructive mt-2 text-[13.5px]">{item.error}</p>
          )}
          {item.status === "sent" && (
            <p className="text-muted-foreground mt-2 text-[12.5px]">
              Sent {when(item.sentAt)} · {item.sentVia === "resend" ? "Resend" : "Gmail"} message id{" "}
              <span className="font-mono">{item.messageId}</span>
              {item.sentVia === "resend" && (
                <>
                  {" · "}
                  {/* NULL is NOT READ, never "not delivered". A message accepted
                      a second ago normally reads as "sent" rather than
                      "delivered", so the reading is dated. */}
                  {item.deliveryEvent
                    ? `Resend last reported “${item.deliveryEvent}” at ${when(item.deliveryReadAt)}`
                    : "Resend's delivery event was not read; that is not the same as not delivered"}
                </>
              )}
            </p>
          )}
          {refused && <p role="alert" className="text-destructive mt-2 text-[13.5px]">{refused}</p>}

          {item.status === "uncertain" && <div className="mt-3 flex flex-wrap gap-2 text-sm">
            <a className="underline" href="https://mail.google.com/mail/u/0/#sent" target="_blank" rel="noreferrer">Check Gmail Sent</a>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => {
              if (confirm("Have you checked the correct Gmail account's Sent folder and confirmed this exact message was NOT sent? Unlocking it permits another delivery attempt.")) void run(() => mailflowApi.resolve(item.id));
            }}>I checked: not sent</Button>
          </div>}
          {live && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={busy}>
                <Pencil /> Edit
              </Button>
              {item.status !== "approved" && requireApproval && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(() => mailflowApi.approve(item.id, item.approvalKey))}
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
                  {busy ? <Loader2 className="animate-spin" /> : <Send />} Send it
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void run(() => mailflowApi.dismiss(item.id))}
              >
                <Trash2 /> Dismiss
              </Button>
            </div>
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
  if (!open) return <Button size="sm" variant="outline" onClick={() => setOpen(true)}><Pencil />Write a draft</Button>;
  return <section className="bg-card rounded-xl p-5 space-y-3 mb-4">
    <h2 className="font-medium">{reply?.thread ? "Draft a reply" : "New draft"}</h2>
    {reply?.back && <Link className="text-sm underline" to={reply.back}>Back to conversation</Link>}
    <label className="block text-sm">From<select aria-label="From account" value={account} disabled={!!reply?.thread} onChange={e => setAccount(e.target.value)} className="block border rounded p-2 w-full">
      <option value="">Choose a Gmail account</option>{accounts.map(a => <option key={a.id} value={a.id}>{a.address ?? a.label}</option>)}
    </select></label>
    <label className="block text-sm">To<Input value={to} type="email" onChange={e => setTo(e.target.value)} /></label>
    <label className="block text-sm">Subject<Input value={subject} maxLength={300} onChange={e => setSubject(e.target.value)} /></label>
    <label className="block text-sm">Message<Textarea value={body} maxLength={20000} rows={8} onChange={e => setBody(e.target.value)} /></label>
    <label className="block text-sm">Venture<select value={venture} onChange={e => setVenture(e.target.value)} className="block border rounded p-2 w-full"><option value="">No venture</option>{state.ventures.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
    {(error || toError || subjectError || bodyError) && <p role="alert" className="text-destructive text-sm">{error || toError || subjectError || bodyError}</p>}
    <div className="flex gap-2"><Button disabled={busy || !account || !to.trim() || !subject.trim() || !body.trim()} onClick={async () => {
      setBusy(true); setError(null);
      try { const result = await mailflowApi.draft({ to, subject, body, account: Number(account), venture: venture || null, inReplyTo: reply?.thread }); onCreated(result.item); setTo(""); setSubject(""); setBody(""); setOpen(false); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { setBusy(false); }
    }}>Save draft</Button><Button variant="ghost" onClick={() => setOpen(false)}>Close · keep draft</Button></div>
    <p className="text-xs text-muted-foreground">Drafts save on this device as you type. Sending requires your owner sign-in and a reviewed preview.</p>
  </section>;
}

export function Outbox() {
  const [offset, setOffset] = useState(0);
  const [tab, setTab] = useState<OutboxStatus | "all">("draft");
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
    /* A status change moves the row between tabs, so the counts have to be
       re-read. The list is small and local; this is one cheap request. */
    doc.reload();
  }

  return (
    <PageShell
      title="Outbox"
      sub={
        <>
          Mail written here — by the agent or by you — and sent only when you
          press Send. Nothing on this page goes out on its own.
        </>
      }
    >
      {d && <Composer accounts={d.accounts} onCreated={() => { setOffset(0); setTab("draft"); doc.reload(); }} />}
      {d && (
        <p className="text-muted-foreground mb-4 text-[12.5px] leading-relaxed">
          Default mailbox: {d.mailbox.address ?? "connect Gmail in Integrations"} ·{" "}
          {d.today.sent} of {d.today.cap} sent today ·{" "}
          {d.settings.gapDays === 0
            ? "no per-address floor"
            : `one message per address per ${d.settings.gapDays} days, dismissed rows included`}{" "}
          ·{" "}
          {d.settings.requireApproval
            ? "drafts require approval"
            : "approval is switched off — your Send approves on the way past. The agent still cannot send."}
        </p>
      )}

      <SubTabs
        tabs={TABS.map((t) => ({
          key: t.key,
          label: t.label,
          count: d && t.key !== "all" ? d.counts[t.key] : undefined,
        }))}
        activeKey={tab}
        onSelect={(k) => {
          setTab(k as OutboxStatus | "all");
          setOffset(0);
        }}
        className="mb-4"
      />

      {doc.error && (
        <p className="text-muted-foreground mb-4 text-[14px]">
          The outbox could not be read.{" "}
          <span className="text-destructive">{doc.error}</span>
        </p>
      )}

      {doc.loading && !d && (
        <p className="text-muted-foreground text-[14px]">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
          Reading the queue.
        </p>
      )}

      {d && d.items.length === 0 && (
        <p className="text-muted-foreground text-[14px]">
          No messages in this view. Create a draft to get started.
        </p>
      )}

      {d && <div className="flex gap-3 items-center text-sm mb-3"><button disabled={offset === 0 || doc.loading} onClick={() => setOffset(n => Math.max(0, n - 50))}>Previous</button><span>{d.pagination.total ? offset + 1 : 0}–{offset + d.items.length} of {d.pagination.total}</span><button disabled={offset + d.items.length >= d.pagination.total || doc.loading} onClick={() => setOffset(n => n + 50)}>Next</button><button className="underline ml-auto" onClick={doc.reload}>Refresh</button></div>}
      {d?.items.map((item) => (
        <Card
          key={item.id}
          item={item}
          requireApproval={d.settings.requireApproval}
          onChanged={replace}
        />
      ))}

      {d && (
        <p className="text-muted-foreground/70 mt-8 text-[12.5px] leading-relaxed">
          {d.note}
        </p>
      )}
    </PageShell>
  );
}
