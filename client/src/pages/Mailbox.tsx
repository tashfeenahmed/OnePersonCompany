import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Image,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  Paperclip,
  RefreshCw,
  Reply,
  Search,
  Send,
} from "lucide-react";
import { ago, bytes, when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { HostMark } from "@/components/HostMark";
import { Input } from "@/components/ui/input";
import { useApi } from "@/hooks/useApi";
import { useStore, type Venture } from "@/lib/store";
import {
  api,
  type MailMessage,
  type MailThread,
  type MailboxChip,
  type SentEmailDoc,
} from "@/lib/api";
import { mailflowApi, type TriageThread } from "@/lib/api/mailflow";
import { decodeEntities, deliveryLabel, mailTime, parseStamp, senderName } from "@/lib/mailText";
import { Avatar, EmptyState, LinkButton, ToneChip, TriageChip, VentureTag } from "@/areas/mailflow/parts";

/**
 * MAILBOX — every venture's mail in one list, and the reader beside it.
 *
 * THE SETUP THIS PAGE IS BUILT AROUND, and it is the common one for a
 * portfolio: every domain routes its mail through one provider into a single
 * Gmail account, and Resend sends back out as any address on those domains. So
 * there is ONE inbox, and a venture's "mailbox" is a filter on it rather than
 * a place: the chips are Gmail queries — `to:(@one-of-your-domains)` — run on
 * the server, not a predicate
 * over rows already fetched. That distinction is the whole reason the chip
 * lives in the URL and the count under it can be trusted; filtering 25 rows in
 * the browser would report "3 threads" for a venture with hundreds, and the
 * number would be a fact about the page size.
 *
 * NOTHING HERE IS STORED, ANYWHERE. Not in the store, not in localStorage, not
 * in a service worker. Subjects and bodies arrive live from Gmail through the
 * server and are gone when this component unmounts — the server keeps the same
 * rule from its end (`routes/mailbox.ts`), and the collector that fills the
 * Email STATS page next door still reads into tables whose schema cannot hold
 * a subject at all. Two different contracts, deliberately, because they answer
 * two different questions.
 *
 * THE LAYOUT RULE, WHICH IS THE THING MOST EASILY GOT WRONG. This page is
 * exactly one viewport tall and the two panes are the ONLY scrollers. The app
 * shell above it already owns the viewport height, so this takes `min-h-0
 * flex-1 overflow-hidden` rather than a height of its own — a nested `h-dvh`
 * here would be the full viewport again UNDER a 48px tab strip, which is a
 * page 48px too tall and a second scrollbar behind the pane's own. `min-h-0`
 * is the load-bearing half: a flex child's default `min-height:auto` refuses
 * to shrink below its content, so without it a long list pushes the shell open
 * and the whole app scrolls instead of the list.
 *
 * WIDE IS TWO PANES, NARROW IS A DRILL-IN. Below `md` there is not room for a
 * list and a reader at once, so the reader replaces the list and a back arrow
 * returns. It is the same component in both cases — one tree, two widths —
 * because a second mobile tree is a second place for the mark-read behaviour
 * to be subtly different.
 *
 * TWO MODES, AND THE TAB STRIP IS NOT THIS PAGE'S ANY MORE. Inbox and Sent by
 * apps are the first two tabs of the Email page's header (pages/Email.tsx),
 * which is what mounts this one, so the mode arrives as a prop rather than as
 * a strip drawn an inch under the strip that already offers it. The default is
 * there for a caller that renders the mailbox on its own.
 *
 * A mail page of this shape wants four modes: the other two are priority and
 * promises, both of which need a model to read the prose. Triage is the first
 * of those and Commitments the second, and both are their own pages under the
 * same header — which is why nothing here pretends they are missing.
 */
export function Mailbox({ mode = "inbox" }: { mode?: Mode }) {
  const [params, setParams] = useSearchParams();
  const { state } = useStore();
  const ventures = state.ventures;

  /*
    THE MODE AND THE CHIP LIVE IN THE URL; THE OPEN THREAD DOES NOT.

    A filtered inbox is a PLACE — "that venture's mail" is somewhere you come back
    to and somewhere you send yourself a link to — so it survives a reload and
    can be bookmarked, exactly as `?site=` does on the search boards. An open
    thread is not: Gmail's thread ids are internal, they mean nothing in
    another mailbox, and a URL that 404s tomorrow is worse than one that lands
    on the list. So the selection is state and the filter is an address.

    A `?mailbox=` naming nothing falls back to everything rather than to an
    empty list — an empty list is a claim ("this venture has no mail") and a
    typo should not be able to make it. The server takes the same view and says
    so in `mailboxIgnored`.
  */
  const chip = params.get("mailbox");

  const [typed, setTyped] = useState("");
  const q = useDebounced(typed, 350);

  /** Gmail's opaque cursor for the page being shown, and the stack of the ones
   *  behind it. Gmail hands out a "next" and never a "previous", so going back
   *  means remembering where you were rather than asking. */
  const [page, setPage] = useState<string | null>(null);
  const [back, setBack] = useState<(string | null)[]>([]);

  const [open, setOpen] = useState<Opened>(() => { const id = new URLSearchParams(window.location.search).get("thread"); return id ? { kind: "thread", id } : null; });

  /** Move the address, and reset everything the address invalidates. Page
   *  three of the old query is not page three of the new one — Gmail's cursors
   *  are not portable between queries — and the thread that was open may not
   *  be in the new list at all. */
  const put = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setPage(null);
    setBack([]);
    setOpen(null);
    setParams(next, { replace: true });
  };

  const chips = useApi(() => api.mailboxes(), []);
  const connected = chips.data?.connected ?? null;

  /* WHAT PRIORITY MADE OF EACH THREAD, drawn on the inbox rows as a chip
     ("Needs reply", "FYI"…). The triage document is a database read on the
     server, so this costs no Gmail quota; a failure just means no chips. */
  const triage = useApi(async () => (mode === "inbox" ? await mailflowApi.triage() : null), [mode]);
  const sorted = useMemo(() => {
    const map = new Map<string, TriageThread>();
    const d = triage.data;
    if (!d) return map;
    for (const rows of Object.values(d.groups)) for (const t of rows) map.set(t.id, t);
    for (const t of d.done ?? []) map.set(t.id, t);
    for (const t of d.snoozedList ?? []) map.set(t.id, t);
    return map;
  }, [triage.data]);

  const forceRefresh = useRef(false);
  const threads = useApi(
    async () => {
      if (mode !== "inbox" || !connected) return null;
      const refresh = forceRefresh.current;
      forceRefresh.current = false;
      return api.mailboxThreads({ q, mailbox: chip, page, refresh });
    },
    [mode, connected, q, chip, page],
  );

  /* The Gmail chip is a RECEIVING address and this list is what was SENT, so
     it is not offered in this mode and is ignored if the URL carries it — the
     merged list is a better answer than a 404 about a filter that cannot apply
     here. */
  const sentDomain = chip === "gmail" ? null : chip;
  const sent = useApi(
    async () =>
      mode === "sent" ? await api.mailboxSent({ domain: sentDomain, page }) : null,
    [mode, sentDomain, page],
  );

  /* Whichever list is live. The two are never both drawn, and the reader below
     takes its emptiness from this rather than from the mode — a mode with a
     failed fetch and a mode with no rows are different states. */
  /* `chips.loading` is in here because the thread fetch waits on it: until the
     chip list has answered, `connected` is null and the threads call has not
     been made at all. Without it the list renders "nothing matches" for the
     half-second before the first request even leaves — an empty state is a
     claim, and it must not be made about a question nobody has asked yet. */
  const loading =
    (chips.loading && !chips.data) || (mode === "inbox" ? threads.loading && !threads.data : sent.loading && !sent.data);
  const refreshing = mode === "inbox" ? threads.loading : sent.loading;
  function refreshMail() {
    if (mode === "inbox") { forceRefresh.current = true; setReadNow({}); threads.reload(); }
    else sent.reload();
  }
  const error = mode === "inbox" ? threads.error : sent.error;

  /**
   * Rows the reader has marked read, held here rather than re-fetched.
   *
   * The server has changed Gmail; this list has not been asked again. Re-
   * fetching the page to un-bold one row costs 260 quota units and a second of
   * spinner to change one font weight. So the id is remembered and the row
   * reads from that — which also means the change survives paging back and
   * forth, and disappears on a real reload, which is when the truth arrives
   * anyway.
   */
  const [readNow, setReadNow] = useState<Record<string, boolean>>({});
  const markedRead = useCallback(
    (id: string, unread: boolean) => setReadNow((s) => ({ ...s, [id]: unread })),
    [],
  );

  /* The server's list carries the Gmail chip at the end of it — one array, so
     a caller cannot forget the personal mailbox exists. This row draws it
     separately (it is last, and it is only offered in the inbox), so the
     venture chips are the domain-kind ones and the Gmail one is filtered out
     here rather than rendered twice.

     Memoised because the labeller closes over it and every row calls the
     labeller: a fresh array each render would rebuild that closure on every
     keystroke in the search box for no change in what it answers. */
  const domains = useMemo(
    () => (chips.data?.mailboxes ?? []).filter((m) => m.kind === "domain"),
    [chips.data],
  );
  const label = useCallback(
    (key: string | null) => chipLabel(key, domains, ventures),
    [domains, ventures],
  );

  /* ------------------------------------------------------------- states */

  if (chips.error)
    return (
      <Center
        title="Can't reach your mail right now"
        body="The app's server isn't answering. Check it's running, then reload this page."
      />
    );

  if (connected === false)
    return (
      <Center
        title="Connect your Gmail to see your mail here"
        body="Once Gmail is connected, every venture's mail shows up in this inbox."
        action={{ to: "/integrations/gmail", label: "Connect Gmail" }}
      />
    );

  const rows = threads.data?.threads ?? [];
  const sentRows = sent.data?.emails ?? [];
  const nextPage = mode === "inbox" ? (threads.data?.nextPage ?? null) : (sent.data?.nextPage ?? null);
  const canPage = mode === "inbox" || (sent.data?.pageable ?? false);

  const listPane = (
    /* NARROW: this IS the page until a thread opens, and then it is replaced.
       `hidden md:flex` rather than a second mobile tree — one tree at two
       widths, so the mark-read dwell cannot behave differently on a phone. */
    <div
      className={cn(
        "min-h-0 w-full flex-col md:flex md:w-[380px] md:shrink-0 md:border-r lg:w-[420px]",
        open ? "hidden" : "flex",
      )}
    >
      {/* The controls do not scroll with the rows. */}
      <div className="shrink-0 border-b px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-1.5">
          {mode === "inbox" ? (
            <div className="relative min-w-0 flex-1">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setPage(null);
                  setBack([]);
                }}
                placeholder="Search mail"
                title='Works like Gmail search: from:someone, has:attachment, "exact words"'
                className="h-8 pl-8 text-[13.5px]"
                aria-label="Search mail"
              />
            </div>
          ) : (
            <p className="text-muted-foreground min-w-0 flex-1 truncate text-[12.5px]">
              Newest first, from every product that sends email
            </p>
          )}
          <Button variant="ghost" size="icon-sm" disabled={refreshing} aria-label="Refresh" title="Check for new mail" onClick={refreshMail}>
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
        </div>
        {mode === "inbox" && threads.data?.readAt && <p className="text-muted-foreground mt-1 text-[11px]" role="status">
          {refreshing ? "Checking…" : `Checked ${ago(threads.data.readAt)}`}
        </p>}

        {/* Which venture's mail. Scrolls sideways rather than wrapping. */}
        <div className="mt-2 flex items-center gap-1 overflow-x-auto pb-0.5">
          <Chip active={!chip} onClick={() => put("mailbox", null)} label="All" />
          {domains.map((m) => (
            <Chip
              key={m.key}
              active={chip === m.key}
              onClick={() => put("mailbox", chip === m.key ? null : m.key)}
              label={label(m.key)}
              host={m.domain}
              title={m.domain ? `Mail sent to @${m.domain}` : undefined}
            />
          ))}
          {chips.data?.gmail && mode === "inbox" && (
            <Chip
              active={chip === "gmail"}
              onClick={() => put("mailbox", chip === "gmail" ? null : "gmail")}
              label="Personal"
              title={`Mail sent to ${chips.data.gmail.address ?? "your Gmail address"}`}
            />
          )}
        </div>
      </div>

      {/* THE FIRST OF THE TWO SCROLLERS. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <ListNote
            title="Couldn't load your mail"
            body={error}
            action={
              mode === "inbox"
                ? { to: "/integrations/gmail", label: "Check the Gmail connection" }
                : { to: "/integrations/resend", label: "Check the Resend connection" }
            }
          />
        ) : loading ? (
          <ListSkeleton />
        ) : mode === "inbox" ? (
          rows.length ? (
            rows.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                unread={readNow[t.id] ?? t.unread}
                active={open?.kind === "thread" && open.id === t.id}
                venture={t.mailbox && t.mailbox !== "gmail" ? { host: t.mailbox, name: label(t.mailbox) } : null}
                sorted={sorted.get(t.id) ?? null}
                onOpen={() => setOpen({ kind: "thread", id: t.id })}
              />
            ))
          ) : (
            <EmptyState
              icon={q ? Search : InboxIcon}
              title={q ? "No emails match your search" : "Nothing here"}
              body={q ? "Try fewer words, or clear the search." : chip ? "No mail for this venture yet. Pick All to see everything." : "Your inbox is empty."}
            />
          )
        ) : sentRows.length ? (
          sentRows.map((e) => (
            <SentRow
              key={`${e.domain}:${e.id}`}
              row={e}
              venture={{ host: e.domain, name: label(e.domain) }}
              active={open?.kind === "sent" && open.id === e.id}
              onOpen={() => setOpen({ kind: "sent", id: e.id, domain: e.domain })}
            />
          ))
        ) : (
          <EmptyState
            icon={Send}
            title="No automatic emails yet"
            body="When your products send sign-up or receipt emails through Resend, they show up here."
            action={<LinkButton to="/integrations/resend">Connect Resend</LinkButton>}
          />
        )}

        {mode === "sent" && !!sent.data?.restricted.length && (
          <ListNote
            title="Some products can't be shown"
            body={`${sent.data.restricted.join(", ")}: the Resend key can only send, not read back. Use a full-access key to see these emails here.`}
          />
        )}
        {mode === "inbox" && threads.data?.mailboxIgnored && (
          <ListNote
            title="Showing all mail"
            body={`Nothing is set up for ${threads.data.mailboxIgnored}, so the whole inbox is shown instead.`}
          />
        )}
      </div>

      {/* Paging is a footer rather than an infinite scroll: Gmail's cursor is
          a "next" and never a "previous", so the stack behind the button is
          this page's memory and it should be visible that it exists. */}
      {canPage && (back.length > 0 || nextPage) && (
        <div className="text-muted-foreground flex shrink-0 items-center gap-2 border-t px-3 py-2 text-[12.5px]">
          <button
            type="button"
            disabled={!back.length}
            onClick={() => {
              setPage(back[back.length - 1] ?? null);
              setBack((s) => s.slice(0, -1));
              setOpen(null);
            }}
            className="hover:bg-accent disabled:pointer-events-none disabled:opacity-40 flex items-center gap-1 rounded-md px-1.5 py-1"
          >
            <ChevronLeft className="size-3.5" /> Newer
          </button>
          <span className="tabular-nums">
            {mode === "inbox" ? rows.length : sentRows.length} shown
            {back.length ? ` · page ${back.length + 1}` : ""}
          </span>
          <button
            type="button"
            disabled={!nextPage}
            onClick={() => {
              setBack((s) => [...s, page]);
              setPage(nextPage);
              setOpen(null);
            }}
            className="hover:bg-accent disabled:pointer-events-none disabled:opacity-40 ml-auto flex items-center gap-1 rounded-md px-1.5 py-1"
          >
            Older <ChevronRight className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );

  const readerPane = (
    <div
      className={cn(
        "min-h-0 min-w-0 flex-1 flex-col md:flex",
        open ? "flex" : "hidden",
      )}
    >
      {open === null ? (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState
            icon={mode === "inbox" ? MailOpen : Send}
            title={mode === "inbox" ? "Pick an email to read it" : "Pick an email to see it"}
            body={mode === "inbox" ? "You can reply, mark it done or open it in Gmail from here." : "You'll see exactly what your customer received."}
          />
        </div>
      ) : open.kind === "thread" ? (
        <ThreadReader
          key={open.id}
          id={open.id}
          onBack={() => setOpen(null)}
          onRead={markedRead}
          venture={label}
          sorted={sorted.get(open.id) ?? null}
          onSortedChange={() => triage.reload()}
          gmailAddress={(accountId) => chips.data?.accounts.find((a) => a.id === accountId)?.label ?? chips.data?.gmail?.address ?? null}
        />
      ) : (
        <SentReader
          key={`${open.domain}:${open.id}`}
          domain={open.domain}
          id={open.id}
          onBack={() => setOpen(null)}
        />
      )}
    </div>
  );

  return (
    /*
      ONE VIEWPORT TALL, AND THE OVERFLOW STOPS HERE. `overflow-hidden` on this
      row is the invariant the two panes rely on: with it, anything that
      overflows is a bug inside a pane; without it, the app itself grows a
      second scrollbar and every height below becomes a guess.
    */
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Wide: both panes, always. Narrow: exactly one of them is visible, and
          the back arrow inside the reader is the way out. Each pane carries
          its own responsive display so there is no wrapper whose `contents`
          has to win an ordering argument with a `hidden`. */}
      {listPane}
      {readerPane}
    </div>
  );
}

/* ====================================================================== */
/*  Modes                                                                 */
/* ====================================================================== */

/** Which list this page is: the inbox as Gmail has it, or what the apps sent
 *  through Resend. The Email page's header picks it. */
export type Mode = "inbox" | "sent";
type Opened =
  | { kind: "thread"; id: string }
  | { kind: "sent"; id: string; domain: string }
  | null;

/* ====================================================================== */
/*  Naming a chip                                                         */
/* ====================================================================== */

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A domain, named after a venture where one honestly matches.
 *
 * VENTURES HERE HAVE NO DOMAIN FIELD. A venture is a name, a description and a
 * colour, and there is no join to make — so this matches the venture's NAME
 * against the domain, both normalised, either whole (`acme.ie` ↔ "acme.ie") or
 * against the domain's stem (`acme.ie` ↔ "Acme"). Equality, never a
 * substring: "acme" inside "acmenauts.io" is a coincidence, and a chip labelled
 * with the wrong business is worse than one labelled with a domain.
 *
 * A DOMAIN THAT MATCHES NOTHING KEEPS ITS OWN NAME. A hard-coded table —
 * `acmetools.io` → "Acme Tools" — is only maintainable where somebody keeps it
 * beside the page, and this install has no such list. Deriving one would mean
 * inventing "Example Fitness" out of `example-app-9.example.test` and presenting it as the name
 * of a business nobody called that.
 */
function chipLabel(key: string | null, chips: MailboxChip[], ventures: Venture[]): string {
  if (!key) return "All";
  if (key === "gmail") return "Gmail";
  const domain = chips.find((c) => c.key === key)?.domain ?? key;
  const whole = norm(domain);
  const stem = norm(domain.split(".")[0] ?? domain);
  const venture = ventures.find((v) => {
    const n = norm(v.name);
    return n === whole || n === stem;
  });
  return venture?.name ?? domain;
}

/* A MESSAGE'S OWN STAMP AND AN ATTACHMENT'S SIZE both come from `@/lib/format`
   now. Both said "" for a missing value rather than the em dash, and both
   still do — a message with no date and an attachment with no size draw
   NOTHING here, because a dash in a mail header reads as a field the server
   sent empty rather than one it never had. That is what `nullText` is for. */
const NOTHING = { nullText: "" } as const;

/* ====================================================================== */
/*  Debounce                                                              */
/* ====================================================================== */

/**
 * The search box, slowed to what a query costs.
 *
 * Every keystroke here is a Gmail search plus twenty-five thread reads — 260
 * quota units — so typing "invoice" un-debounced is seven searches, six of
 * them for prefixes nobody meant. 350ms is long enough to cover normal typing
 * and short enough that it does not feel like a submit button.
 */
function useDebounced(value: string, ms: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/* ====================================================================== */
/*  The list                                                              */
/* ====================================================================== */

function Chip({
  active,
  label,
  title,
  host,
  onClick,
}: {
  active: boolean;
  label: string;
  title?: string;
  /** A venture domain: its favicon is drawn before the name. */
  host?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-foreground flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[12.5px] whitespace-nowrap",
        active && "bg-foreground text-background border-foreground hover:bg-foreground hover:text-background",
      )}
    >
      {host && <HostMark host={host} size={13} />}
      {label}
    </button>
  );
}

/** Placeholder rows while the first page loads. */
function ListSkeleton() {
  return (
    <div role="status" aria-label="Loading mail">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex gap-3 border-b px-3 py-3">
          <span className="bg-muted size-8 shrink-0 animate-pulse rounded-full" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="bg-muted h-3 w-1/3 animate-pulse rounded" />
            <span className="bg-muted h-3 w-3/4 animate-pulse rounded" />
            <span className="bg-muted/70 h-3 w-2/3 animate-pulse rounded" />
          </span>
        </div>
      ))}
    </div>
  );
}

function ThreadRow({
  thread: t,
  unread,
  active,
  venture,
  sorted,
  onOpen,
}: {
  thread: MailThread;
  unread: boolean;
  active: boolean;
  /** The venture this arrived at, or null for personal mail. */
  venture: { host: string; name: string } | null;
  /** What Priority made of it, when it has been sorted. */
  sorted: TriageThread | null;
  onOpen: () => void;
}) {
  const name = senderName(t.fromName, t.from);
  const done = !!sorted?.doneAt;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      className={cn(
        "hover:bg-accent/60 flex w-full items-start gap-3 border-b px-3 py-2.5 text-left",
        active && "bg-accent",
      )}
    >
      <Avatar name={name} address={t.from} size={34} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex w-full items-baseline gap-2">
          {unread && <span className="bg-primary size-2 shrink-0 self-center rounded-full" aria-label="Unread" />}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-[13.5px]",
              unread ? "text-foreground font-semibold" : "text-foreground/90",
            )}
            title={t.from}
          >
            {name}
            {t.messages > 1 && (
              <span className="text-muted-foreground font-normal"> · {t.messages}</span>
            )}
          </span>
          <span className={cn("shrink-0 text-[11.5px] tabular-nums", unread ? "text-foreground font-medium" : "text-muted-foreground")}>
            {mailTime(t.at)}
          </span>
        </span>
        <span className={cn("w-full truncate text-[13px]", unread ? "font-medium" : "text-foreground/80")}>
          {t.subject || "(no subject)"}
        </span>
        {t.snippet && (
          <span className="text-muted-foreground w-full truncate text-[12.5px]">{decodeEntities(t.snippet)}</span>
        )}
        {(sorted?.score || done || venture) && (
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
            {sorted?.score && !done && <TriageChip score={sorted.score} urgency={sorted.urgency} />}
            {done && (
              <ToneChip tone="muted" title="You marked this done in Priority">
                <Check /> Done
              </ToneChip>
            )}
            {venture && <VentureTag host={venture.host} name={venture.name} />}
          </span>
        )}
      </span>
    </button>
  );
}

function SentRow({
  row,
  venture,
  active,
  onOpen,
}: {
  row: { id: string; domain: string; at: string; to: string[]; subject: string; lastEvent: string | null };
  venture: { host: string; name: string };
  active: boolean;
  onOpen: () => void;
}) {
  const to = row.to[0] ?? "";
  const status = deliveryLabel(row.lastEvent);
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-current={active ? "true" : undefined}
      className={cn(
        "hover:bg-accent/60 flex w-full items-start gap-3 border-b px-3 py-2.5 text-left",
        active && "bg-accent",
      )}
    >
      <Avatar name={senderName(null, to)} address={to} size={34} className="mt-0.5" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex w-full items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13.5px]" title={row.to.join(", ")}>
            <span className="text-muted-foreground">To </span>
            {to || "(no recipient)"}
            {row.to.length > 1 && <span className="text-muted-foreground"> +{row.to.length - 1}</span>}
          </span>
          <span className="text-muted-foreground shrink-0 text-[11.5px] tabular-nums">
            {mailTime(parseStamp(row.at))}
          </span>
        </span>
        <span className="w-full truncate text-[13px]">{row.subject || "(no subject)"}</span>
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
          <ToneChip tone={status.tone}>{status.label}</ToneChip>
          <VentureTag host={venture.host} name={venture.name} />
        </span>
      </span>
    </button>
  );
}

/* ====================================================================== */
/*  The reader                                                            */
/* ====================================================================== */

/** Gmail's own page for one thread, in the right account. Gmail accepts the
 *  API's thread id in the web address. */
function gmailLink(threadId: string, address: string | null): string {
  const who = address ? `?authuser=${encodeURIComponent(address)}` : "";
  return `https://mail.google.com/mail/u/${who}#all/${encodeURIComponent(threadId)}`;
}

/**
 * One thread.
 *
 * MARKING READ HAPPENS AFTER A DWELL, NOT ON CLICK. A click is often a
 * mis-click, so a second and a half of the thread actually being on screen is
 * the signal; the timer is cancelled if the thread closes first. The Mark
 * unread button puts the flag back.
 *
 * THE ACTIONS, LEFT TO RIGHT: Reply (opens the composer in Drafts, addressed
 * and threaded), Done (takes it off Priority — Gmail is not touched), Mark
 * read/unread, and Open in Gmail — which is where archiving and deleting live.
 */
function ThreadReader({
  id,
  onBack,
  onRead,
  venture,
  sorted,
  onSortedChange,
  gmailAddress,
}: {
  id: string;
  onBack: () => void;
  onRead: (id: string, unread: boolean) => void;
  venture: (key: string | null) => string;
  sorted: TriageThread | null;
  onSortedChange: () => void;
  gmailAddress: (accountId: number) => string | null;
}) {
  const account = Number(new URLSearchParams(window.location.search).get("account")) || undefined;
  const thread = useApi(() => api.mailboxThread(id, { account }), [id, account]);
  /** Which message's remote images have been asked for. One at a time. */
  const [images, setImages] = useState<string | null>(null);
  const [unread, setUnread] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [doneNow, setDoneNow] = useState<boolean | null>(null);

  const doc = useApi(
    async () => (images ? await api.mailboxThread(id, { images, account }) : null),
    [id, account, images],
  );
  const shown = images && doc.data ? doc.data : thread.data;

  const isUnread = unread ?? shown?.messages.some((m) => m.unread) ?? false;
  const isDone = doneNow ?? !!sorted?.doneAt;

  const setRead = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setFailed(null);
      try {
        await api.mailboxMarkRead(id, next, account);
        setUnread(next);
        onRead(id, next);
      } catch (e) {
        /* A failed write says so and changes nothing. */
        setFailed(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [id, account, onRead],
  );

  async function toggleDone(accountId: number) {
    setBusy(true);
    setFailed(null);
    try {
      await mailflowApi.done(id, { account: accountId, undo: isDone });
      setDoneNow(!isDone);
      onSortedChange();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!thread.data) return;
    if (!thread.data.messages.some((m) => m.unread)) return;
    const t = setTimeout(() => void setRead(false), 1500);
    return () => clearTimeout(t);
    // `setRead` is stable per thread; the dwell is about this thread arriving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.data]);

  if (thread.error)
    return <ReaderNote onBack={onBack} title="This email wouldn't open" body={thread.error} />;
  if (thread.loading || !shown)
    return <ReaderNote onBack={onBack} title="Opening…" body="" />;

  const replyTo =
    shown.messages.findLast((m) => !m.labels.includes("SENT"))?.from ?? shown.messages.at(-1)?.to.split(",")[0] ?? "";
  const reply = {
    to: replyTo,
    subject: /^re:/i.test(shown.subject) ? shown.subject : `Re: ${shown.subject}`,
    account: shown.accountId,
    thread: id,
    back: `/mail/inbox?thread=${encodeURIComponent(id)}&account=${shown.accountId}`,
  };

  return (
    <>
      <header className="shrink-0 border-b px-3.5 pt-2.5 pb-2">
        <div className="flex items-start gap-2">
          <button
            type="button"
            onClick={onBack}
            className="hover:bg-accent text-muted-foreground -ml-1 shrink-0 rounded-md p-1 md:hidden"
            aria-label="Back to the list"
          >
            <ArrowLeft className="size-4" />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] leading-snug font-normal tracking-[-0.01em] break-words">
              {shown.subject || "(no subject)"}
            </h2>
            <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px]">
              {sorted?.score && !isDone && <TriageChip score={sorted.score} urgency={sorted.urgency} />}
              {isDone && <ToneChip tone="muted"><Check /> Done</ToneChip>}
              <span>
                {shown.messages.length} {shown.messages.length === 1 ? "message" : "messages"}
                {shown.mailbox && shown.mailbox !== "gmail" && ` · to ${venture(shown.mailbox)}`}
              </span>
            </p>
          </div>
        </div>
        {sorted?.reason && !isDone && (
          <p className="text-muted-foreground mt-1.5 text-[12.5px] italic">{sorted.reason}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Button size="sm" asChild>
            <Link to="/mail/outbox" state={{ reply }}>
              <Reply /> Reply
            </Link>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void toggleDone(shown.accountId)}
            title={isDone ? "Put it back on your Priority list" : "Take it off your Priority list. Gmail is not changed."}
          >
            <Check /> {isDone ? "Not done" : "Done"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void setRead(!isUnread)}
          >
            {isUnread ? <MailOpen /> : <Mail />}
            {isUnread ? "Mark read" : "Mark unread"}
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <a
              href={gmailLink(id, gmailAddress(shown.accountId))}
              target="_blank"
              rel="noreferrer"
              title="Archive, delete or label it in Gmail"
            >
              <ExternalLink /> Open in Gmail
            </a>
          </Button>
        </div>
        {failed && <p role="alert" className="text-destructive mt-1.5 text-[12.5px]">{failed}</p>}
      </header>

      {/* THE SECOND OF THE TWO SCROLLERS. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {shown.messages.map((m, i) => (
          <MessageBlock
            key={m.id}
            message={m}
            /* Older, already-read messages in a long thread fold to one line. */
            startFolded={shown.messages.length > 2 && i < shown.messages.length - 1 && !m.unread}
            onImages={() => setImages(m.id)}
            imagesBusy={doc.loading && images === m.id}
          />
        ))}
      </div>
    </>
  );
}

/**
 * One email a product sent through Resend. No reply: it came from a robot
 * address and nobody wrote to it. The same reader and sanitiser as the inbox.
 */
function SentReader({ domain, id, onBack }: { domain: string; id: string; onBack: () => void }) {
  const [images, setImages] = useState(false);
  const email = useApi(() => api.mailboxSentEmail(domain, id, images), [domain, id, images]);

  if (email.error)
    return <ReaderNote onBack={onBack} title="This email wouldn't open" body={email.error} />;
  if (email.loading || !email.data)
    return <ReaderNote onBack={onBack} title="Opening…" body="" />;

  const e: SentEmailDoc = email.data;
  const status = deliveryLabel(e.lastEvent);
  /* Shaped into the inbox's message so one component renders both. */
  const asMessage: MailMessage = {
    id: e.id,
    messageId: e.messageId,
    from: e.from,
    fromName: "",
    to: e.to.join(", "),
    cc: e.cc.join(", "),
    subject: e.subject,
    at: parseStamp(e.at),
    unread: false,
    labels: [],
    text: e.text,
    html: e.html,
    remoteImages: e.remoteImages,
    imagesLoaded: e.imagesLoaded,
    attachments: e.attachments,
  };

  return (
    <>
      <header className="flex shrink-0 items-start gap-2 border-b px-3.5 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="hover:bg-accent text-muted-foreground -ml-1 shrink-0 rounded-md p-1 md:hidden"
          aria-label="Back to the list"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="text-[16px] leading-snug font-normal tracking-[-0.01em] break-words">
            {e.subject || "(no subject)"}
          </h2>
          <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px]">
            <ToneChip tone={status.tone}>{status.label}</ToneChip>
            <span>Sent automatically from {e.domain}</span>
          </p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <MessageBlock
          message={asMessage}
          startFolded={false}
          onImages={() => setImages(true)}
          imagesBusy={email.loading}
        />
      </div>
    </>
  );
}

/**
 * One message: its header block, and its body.
 *
 * HTML IS THE MESSAGE WHEREVER IT EXISTS. Real mail ships a plain-text part as
 * a fallback for clients from another decade, and preferring it had every
 * transactional email opening as a wall of bare URLs. The plain version is one
 * click away, because some newsletters genuinely read better that way — and
 * because it is the one rendering path with no markup in it at all.
 */
function MessageBlock({
  message: m,
  startFolded,
  onImages,
  imagesBusy,
}: {
  message: MailMessage;
  startFolded: boolean;
  onImages: () => void;
  imagesBusy: boolean;
}) {
  const [folded, setFolded] = useState(startFolded);
  const [plain, setPlain] = useState(false);
  const rich = m.html !== null && !plain;

  if (folded)
    return (
      <button
        type="button"
        onClick={() => setFolded(false)}
        className="hover:bg-accent/60 mb-1.5 flex w-full items-baseline gap-2 rounded-lg border px-2.5 py-1.5 text-left"
      >
        <span className="max-w-40 shrink-0 truncate text-[13px] font-medium">
          {m.fromName || m.from}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[12px]">
          {m.text.trim().split("\n").find(Boolean) ?? "(no text)"}
        </span>
        <span className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">
          {mailTime(m.at)}
        </span>
      </button>
    );

  return (
    <article className="bg-card mb-3 rounded-lg p-3">
      <header className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b pb-2">
        <span className="text-[13.5px] font-medium" title={m.from}>
          {m.fromName || m.from || "(no sender)"}
        </span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-[12px]">
          to {m.to || "(nobody named)"}
          {m.cc && ` · cc ${m.cc}`}
        </span>
        <span className="text-muted-foreground shrink-0 font-mono text-[11.5px]">
          {when(m.at, { ...NOTHING, year: true })}
        </span>
      </header>

      {rich && m.html ? (
        <HtmlFrame html={m.html} title={m.subject || "this message"} />
      ) : m.text.trim() ? (
        /* The plain path renders as react text nodes and nothing else. There is
           no markup route from a stranger's mail into this document at all,
           which is the point of having it. */
        <pre className="text-foreground/90 font-sans text-[13.5px] leading-relaxed whitespace-pre-wrap">
          {m.text.trim()}
        </pre>
      ) : (
        <p className="text-muted-foreground text-[13px]">
          This email is empty.
        </p>
      )}

      <footer className="text-muted-foreground mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        {m.html && (
          <button
            type="button"
            onClick={() => setPlain((p) => !p)}
            className="hover:text-foreground underline-offset-2 hover:underline"
          >
            {plain ? "Show formatted" : "Show plain text"}
          </button>
        )}
        {/*
          THE IMAGE GATE. A remote image in marketing mail is a tracking pixel
          far more often than it is a picture: loading it tells the sender the
          mail was opened, when, and roughly from where. So the URLs are not
          sent to this browser at all until they are asked for — pressing this
          re-reads the message from the server rather than unhiding something
          already delivered, because a CSS rule is not a promise that nothing
          was fetched.
        */}
        {m.remoteImages > 0 && !m.imagesLoaded && rich && (
          <button
            type="button"
            onClick={onImages}
            disabled={imagesBusy}
            className="hover:text-foreground flex items-center gap-1 disabled:opacity-50"
          >
            <Image className="size-3" strokeWidth={1.7} aria-hidden />
            {imagesBusy ? "Loading images…" : `Show images (${m.remoteImages})`}
          </button>
        )}
        {m.imagesLoaded && m.remoteImages > 0 && (
          <span>Images shown</span>
        )}
        {/* Named and sized, never fetched: an attachment list costs nothing and
            downloading one would be megabytes through the API for something
            nobody clicked. */}
        {m.attachments.map((a) => (
          <span key={a.filename} className="flex items-center gap-1" title={a.mimeType}>
            <Paperclip className="size-3" strokeWidth={1.7} aria-hidden />
            {a.filename}
            {a.size !== null && <span className="opacity-70">· {bytes(a.size, NOTHING)}</span>}
          </span>
        ))}
      </footer>
    </article>
  );
}

/**
 * The sender's HTML, in a frame that cannot do anything.
 *
 * AN IFRAME RATHER THAN `dangerouslySetInnerHTML`, WHICH HAS NO BOUNDARY AT
 * ALL. The document arrives already sanitised and already carrying its own
 * `Content-Security-Policy` — both built on the server, so neither can be
 * forgotten here — and this adds the third wall: the sandbox. No
 * `allow-scripts`, ever, so script that survived the sanitiser and the CSP
 * would still have nothing to run in.
 *
 * `allow-same-origin` IS PRESENT AND `allow-scripts` IS NOT, AND THE PAIR IS
 * THE POINT. Together they are the known escape — a script in a same-origin
 * frame can reach out and remove its own sandbox attribute — but same-origin
 * alone, with scripting off at both the sandbox and the CSP, is inert. What it
 * buys is the height: a cross-origin frame cannot be measured from out here,
 * and the alternative is a fixed height with a scrollbar inside a scroller,
 * which breaks the one-viewport rule this page is built on.
 *
 * `allow-popups(-to-escape-sandbox)` is what lets the links actually open: the
 * server retargets every anchor to `_blank`, and without these a click would
 * navigate the frame itself — the linked site loading in the card where the
 * mail just was, which reads as the dashboard being replaced.
 */
function HtmlFrame({ html, title }: { html: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);

  const measure = useCallback(() => {
    const doc = frame.current?.contentDocument;
    if (!doc?.body) return;
    /* `scrollHeight` of the documentElement rather than the body: a mail whose
       outermost table is absolutely positioned reports a body of nothing. */
    const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
    if (h > 0) setHeight(Math.min(h + 2, 6000));
  }, []);

  useEffect(() => {
    /* Images finish after load and change the height under it. One re-measure
       shortly after is cheaper and less jumpy than a ResizeObserver on a
       document in another browsing context. */
    const t = setTimeout(measure, 400);
    return () => clearTimeout(t);
  }, [measure, html]);

  return (
    <iframe
      ref={frame}
      title={`Message: ${title}`}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={html}
      onLoad={measure}
      style={{ height }}
      /* The one deliberate raw colour on this page. The frame's canvas is
         always white because HTML mail is designed against a white page —
         templates set dark text and leave the background to the client, so a
         transparent canvas in dark mode is near-black text on a near-black
         card. Gmail's own dark mode makes the same call: the message sits on a
         white sheet inside a dark frame and reads as a document. */
      className="w-full rounded-md border-0 bg-white"
    />
  );
}

/* ====================================================================== */
/*  Honest states                                                         */
/* ====================================================================== */

function ListNote({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  /** Offered where there is a page that would actually fix it. A dead Google
   *  grant is the case this exists for: the server's sentence already names
   *  the Integrations page, and a sentence naming a page you then have to go
   *  and find is a worse answer than a link. */
  action?: { to: string; label: string };
}) {
  return (
    <div className="px-3 py-6">
      <p className="text-[13.5px] font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">{body}</p>
      {action && (
        <Link
          to={action.to}
          className="hover:bg-accent mt-2.5 inline-block rounded-lg border px-2 py-1 text-[12.5px]"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}

function ReaderNote({
  title,
  body,
  onBack,
}: {
  title: string;
  body: string;
  onBack: () => void;
}) {
  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b px-3.5 py-2.5 md:hidden">
        <button
          type="button"
          onClick={onBack}
          className="hover:bg-accent text-muted-foreground -ml-1 rounded-md p-1"
          aria-label="Back to the list"
        >
          <ArrowLeft className="size-4" />
        </button>
      </header>
      <div className="flex flex-1 items-center justify-center px-6 text-center">
        <div className="max-w-[340px]">
          <p className="text-[14.5px]">{title}</p>
          {body && <p className="text-muted-foreground mt-1.5 text-[13px] leading-relaxed">{body}</p>}
        </div>
      </div>
    </>
  );
}

function Center({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: { to: string; label: string };
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="max-w-[380px] text-center">
        <h1 className="text-[20px] font-normal tracking-[-0.02em]">{title}</h1>
        <p className="text-muted-foreground mt-1.5 text-[14px] leading-relaxed">{body}</p>
        {action && (
          <Link
            to={action.to}
            className="hover:bg-accent mt-4 inline-block rounded-lg border px-2.5 py-1.5 text-[13.5px]"
          >
            {action.label}
          </Link>
        )}
      </div>
    </div>
  );
}

