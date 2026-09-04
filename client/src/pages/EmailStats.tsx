import { Link } from "react-router-dom";
import { PageShell } from "@/components/PageShell";
import { BrandTile } from "@/components/BrandTile";
import { cn } from "@/lib/utils";
import {
  api,
  type Mailbox,
  type PluginAccount,
  type SendingDomain,
} from "@/lib/api";
import { useApi } from "@/hooks/useApi";
import { ago } from "@/lib/live";
import { PLUGINS } from "@/data/plugins";

/**
 * EMAIL STATS — every mailbox and every sending domain, across all ventures,
 * as figures. The mailbox itself — the threads, the reader — is the Email app
 * beside this one; this is the instrument panel for it.
 *
 * WHY AN APP AND NOT A DASHBOARD. A dashboard is a grid of figures you glance
 * at; this is a place you go to see WHERE mail lives. Ten ventures each send
 * from their own domain through Resend, one Google account reads for all of
 * them, and until now the only view of that was ten rows on an integration
 * page. Workdash solves this with a merged inbox rather than one page per
 * Google account, and this is the same idea one level up: every box, one page.
 *
 * TWO SOURCES, JOINED BY ACCOUNT ID, AND THE JOIN IS THE POINT. Which boxes
 * exist comes from the plugin accounts — the same rows the Integrations page
 * shows — so a domain added there appears here with no second list to keep in
 * step, and a box whose key has stopped working is still a box, drawn with its
 * error. What each box is DOING comes from /api/mail, one document for both
 * ends of the pipe, and is laid over the account row it belongs to. A box with
 * an account row and no mail figures yet is "stored, not yet read", which is a
 * different state from a mailbox with nothing unread.
 *
 * WHAT A "BOX" IS HERE. Two kinds, kept apart on the page because they answer
 * different questions and their numbers do not add:
 *
 *   MAILBOXES     — Google accounts this dashboard can read. "What is waiting
 *                   for me": unread, needing a reply, how old the oldest is.
 *   SENDING       — Resend domains, one per venture. "Can this venture send,
 *                   and is it landing": verified, DNS, bounces.
 *
 * Folding them into one list would put a mailbox with 252 unread threads
 * beside a domain bouncing 15% of its mail as if they were the same kind of
 * problem.
 *
 * NEEDING-REPLY IS A FLOOR AND SAYS SO. The collector scans a bounded number
 * of threads a run, so "230+" is the honest figure when the budget ran out —
 * a count that quietly stopped at the budget would read as the whole queue.
 */
export function EmailStats() {
  const plugins = useApi(() => api.plugins(), []);
  const mail = useApi(() => api.mail(30), []);

  const byId = new Map((plugins.data?.plugins ?? []).map((p) => [p.id, p]));
  const gmailAccounts = byId.get("gmail")?.accounts ?? [];
  const resendAccounts = [...(byId.get("resend")?.accounts ?? [])].sort((a, b) =>
    a.label.localeCompare(b.label),
  );

  const mailboxes = new Map(
    (mail.data?.mailboxes ?? []).map((m) => [m.accountId, m]),
  );
  const domains = new Map(
    (mail.data?.sendingDomains ?? []).map((d) => [d.accountId, d]),
  );

  const inbox = mail.data?.inbox;
  const sending = mail.data?.sending;

  const sub = plugins.error
    ? "The API is not running, so nothing here can be read."
    : plugins.loading
      ? "Reading which boxes exist…"
      : [
          `${gmailAccounts.length} ${gmailAccounts.length === 1 ? "mailbox" : "mailboxes"}`,
          `${resendAccounts.length} sending ${resendAccounts.length === 1 ? "domain" : "domains"}`,
          mail.data?.seenAt ? `read ${ago(mail.data.seenAt)}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <>
      <PageShell title="Email stats" sub={sub} wide>
        {/* The two headline figures, one per kind of box, before any card.
            Summed across mailboxes and across domains respectively — and never
            across the two, which is why they are two tiles and not one. */}
        {(inbox || sending) && (
          <div className="mb-7 grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <Tile
              label="Needing a reply"
              value={
                inbox?.needingReply === null || inbox?.needingReply === undefined
                  ? "—"
                  : `${inbox.needingReply}${inbox.floor ? "+" : ""}`
              }
              sub={
                inbox?.oldestWaitingDays != null
                  ? `oldest waiting ${inbox.oldestWaitingDays}d${inbox.floor ? ` · ${inbox.scanned} threads scanned` : ""}`
                  : "not measured yet"
              }
              tone={
                (inbox?.needingReply ?? 0) > 0
                  ? (inbox?.oldestWaitingDays ?? 0) >= 7
                    ? "warn"
                    : undefined
                  : undefined
              }
            />
            <Tile
              label="Unread threads"
              value={inbox?.unreadThreads == null ? "—" : String(inbox.unreadThreads)}
              sub={
                inbox?.unreadMessages != null
                  ? `${inbox.unreadMessages} messages · Gmail's own counter`
                  : "not measured yet"
              }
            />
            <Tile
              label="Sent · 30d"
              value={sending ? String(sending.sent) : "—"}
              sub={
                sending
                  ? `${sending.delivered} delivered across ${sending.domains} ${sending.domains === 1 ? "domain" : "domains"}`
                  : "not measured yet"
              }
            />
            <Tile
              label="Bounce rate"
              value={
                sending?.bounceRate == null ? "—" : `${sending.bounceRate.toFixed(1)}%`
              }
              sub={
                sending
                  ? `${sending.bounced} bounced · ${sending.rateBasis}`
                  : "not measured yet"
              }
              tone={
                sending?.bounceRate == null
                  ? undefined
                  : sending.bounceRate >= 10
                    ? "bad"
                    : sending.bounceRate >= 5
                      ? "warn"
                      : undefined
              }
            />
          </div>
        )}

        <Section
          title="Mailboxes"
          hint="Google accounts this dashboard reads. What is waiting, and how long it has waited."
          empty={
            <EmptyBox
              text="No mailbox is connected."
              to="/integrations/gmail"
              action="Connect Gmail"
            />
          }
        >
          {gmailAccounts.map((a) => (
            <MailboxCard key={a.id} account={a} box={mailboxes.get(a.id)} />
          ))}
        </Section>

        <Section
          title="Sending domains"
          hint="One Resend key per venture. Whether each can send, and whether it lands."
          empty={
            <EmptyBox
              text="No sending domain is connected."
              to="/integrations/resend"
              action="Connect Resend"
            />
          }
        >
          {resendAccounts.map((a) => (
            <DomainCard key={a.id} account={a} domain={domains.get(a.id)} />
          ))}
        </Section>

        {!!mail.data?.cannot?.length && (
          <p className="text-muted-foreground mt-2 text-[11.5px] leading-snug">
            Not on this page because the providers do not report it:{" "}
            {mail.data.cannot.join(" · ")}
          </p>
        )}
      </PageShell>
    </>
  );
}

/* ------------------------------------------------------------------ pieces */

function Tile({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone?: "warn" | "bad";
}) {
  return (
    <div className="bg-card rounded-[10px] border p-3.5">
      <div className="text-muted-foreground text-[11.5px]">{label}</div>
      <div
        className={cn(
          "mt-1 text-[24px] leading-tight font-normal tracking-[-0.03em] tabular-nums",
          tone === "warn" && "text-warn",
          tone === "bad" && "text-destructive",
        )}
      >
        {value}
      </div>
      <div className="text-muted-foreground mt-1 text-[11.5px]">{sub}</div>
    </div>
  );
}

function Section({
  title,
  hint,
  empty,
  children,
}: {
  title: string;
  hint: string;
  empty: React.ReactNode;
  children: React.ReactNode[];
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[15px] font-medium tracking-[-0.01em]">{title}</h2>
        <span className="text-muted-foreground text-[12px]">{hint}</span>
      </div>
      {children.length ? (
        <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
          {children}
        </div>
      ) : (
        empty
      )}
    </section>
  );
}

function EmptyBox({
  text,
  to,
  action,
}: {
  text: string;
  to: string;
  action: string;
}) {
  return (
    <div className="text-muted-foreground flex items-center gap-3 rounded-[10px] border border-dashed px-4 py-5 text-[12.5px]">
      {text}
      <Link
        to={to}
        className="text-foreground hover:bg-accent ml-auto rounded-lg border px-2.5 py-1"
      >
        {action}
      </Link>
    </div>
  );
}

/** The connection line every box carries: who it is and whether it answers.
 *  Shared by both card kinds so "failing" means one thing on the page. */
function BoxHead({
  icon,
  name,
  account,
  kind,
}: {
  icon: string;
  name: string;
  account: PluginAccount;
  kind: string;
}) {
  const plugin = PLUGINS.find((p) => p.icon === icon);
  const failing = account.connected && !!account.lastError;
  const state = !account.connected
    ? "not connected"
    : failing
      ? "failing"
      : account.lastOkAt
        ? `answered ${ago(account.lastOkAt)}`
        : "stored, not yet read";

  return (
    <>
      <div className="flex items-center gap-2.5">
        <BrandTile
          icon={icon}
          name={name}
          mono={plugin?.mono}
          tint={plugin?.tint}
          className="size-7 rounded-[8px]"
          glyphClassName="size-[14px] text-[11px]"
        />
        <div className="min-w-0">
          <div className="truncate text-[13px] font-medium">{account.label}</div>
          <div className="text-muted-foreground text-[11px]">
            {kind} · {name}
          </div>
        </div>
        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1.5 text-[11px]",
            failing || !account.connected ? "text-warn" : "text-muted-foreground",
          )}
        >
          <i
            className={cn(
              "size-1.5 rounded-full",
              !account.connected ? "bg-border" : failing ? "bg-warn" : "bg-ok",
            )}
          />
          {state}
        </span>
      </div>
      {failing && account.lastError && (
        <p className="text-warn mt-2.5 text-[11.5px] leading-snug">{account.lastError}</p>
      )}
    </>
  );
}

/** A labelled figure inside a card. `null` draws as "—" with the word beside
 *  it left alone, so a mailbox that has not been triaged yet is not a mailbox
 *  with nothing to answer. */
function Fig({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | null;
  tone?: "warn" | "bad";
}) {
  return (
    <div className="min-w-0">
      <div className="text-muted-foreground text-[10.5px] tracking-[0.04em] uppercase">
        {label}
      </div>
      <div
        className={cn(
          "text-[15px] tabular-nums",
          tone === "warn" && "text-warn",
          tone === "bad" && "text-destructive",
        )}
      >
        {value ?? "—"}
      </div>
    </div>
  );
}

function MailboxCard({
  account,
  box,
}: {
  account: PluginAccount;
  box: Mailbox | undefined;
}) {
  return (
    <div className="bg-card flex flex-col rounded-[10px] border p-3.5">
      <BoxHead icon="gmail" name="Gmail" account={account} kind="mailbox" />

      {box ? (
        <>
          <div className="mt-3.5 grid grid-cols-3 gap-3">
            <Fig
              label="Needs reply"
              value={
                box.needingReply === null
                  ? null
                  : `${box.needingReply}${box.floor ? "+" : ""}`
              }
              tone={
                box.needingReply && (box.oldestWaitingDays ?? 0) >= 7
                  ? "warn"
                  : undefined
              }
            />
            <Fig
              label="Unread"
              value={box.unread.threads === null ? null : String(box.unread.threads)}
            />
            <Fig
              label="Oldest"
              value={
                box.oldestWaitingDays === null ? null : `${box.oldestWaitingDays}d`
              }
            />
          </div>
          <div className="text-muted-foreground mt-3 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px]">
            {box.volume.received !== null && (
              <span>
                {box.volume.received} in · {box.volume.sent ?? 0} out over{" "}
                {box.volume.days}d
              </span>
            )}
            <span>
              wrote to {box.outreach.people} {box.outreach.people === 1 ? "person" : "people"}
              {box.outreach.new ? `, ${box.outreach.new} new` : ""}
            </span>
            {box.readOnly.enforced && <span>read-only</span>}
          </div>
        </>
      ) : (
        account.connected && (
          <p className="text-muted-foreground mt-3 text-[11.5px]">
            No figures yet — the collector has not read this mailbox.
          </p>
        )
      )}
    </div>
  );
}

function DomainCard({
  account,
  domain,
}: {
  account: PluginAccount;
  domain: SendingDomain | undefined;
}) {
  const s = domain?.sends;
  const dnsBad = !!domain?.dns.unhealthy.length;
  const verified = domain?.status === "verified";

  return (
    <div className="bg-card flex flex-col rounded-[10px] border p-3.5">
      <BoxHead icon="resend" name="Resend" account={account} kind="sending domain" />

      {domain ? (
        <>
          <div className="mt-3.5 grid grid-cols-3 gap-3">
            <Fig label="Sent · 30d" value={s ? String(s.sent) : null} />
            <Fig
              label="Bounce"
              value={s?.bounceRate == null ? null : `${s.bounceRate.toFixed(1)}%`}
              tone={
                s?.bounceRate == null
                  ? undefined
                  : s.bounceRate >= 10
                    ? "bad"
                    : s.bounceRate >= 5
                      ? "warn"
                      : undefined
              }
            />
            <Fig
              label="DNS"
              value={
                !domain.dns.read
                  ? null
                  : dnsBad
                    ? `${domain.dns.unhealthy.length} unhealthy`
                    : `${domain.dns.verified}/${domain.dns.total}`
              }
              tone={dnsBad ? "bad" : undefined}
            />
          </div>
          <div className="text-muted-foreground mt-3 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px]">
            <span className={cn(!verified && "text-warn")}>
              {domain.status ?? "status unknown"}
            </span>
            {domain.region && <span>{domain.region}</span>}
            {s && s.delivered > 0 && <span>{s.delivered} delivered</span>}
            {s && s.suppressed > 0 && <span>{s.suppressed} suppressed</span>}
            {domain.tracking.open === false && domain.tracking.click === false && (
              <span>no open/click tracking</span>
            )}
          </div>
        </>
      ) : (
        account.connected && (
          <p className="text-muted-foreground mt-3 text-[11.5px]">
            No figures yet — the collector has not read this domain.
          </p>
        )
      )}
    </div>
  );
}
