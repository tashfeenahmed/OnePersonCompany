import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Image,
  Mail,
  MailOpen,
  Paperclip,
  RefreshCw,
  Search,
} from "lucide-react";
import { ago, bytes, day, when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
        title="The API is not running"
        body="This page reads Gmail through the local API, and nothing is answering on port 8787. Start the server and reload."
      />
    );

  if (connected === false)
    return (
      <Center
        title="No mailbox is connected"
        body="Every venture's mail funnels into one Google account, and this dashboard has not been given one. Connect Gmail and this page fills itself."
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
      {/* The controls do not scroll with the rows. A search box that leaves
          the top of the list is a search box you scroll back up to reach. */}
      <div className="shrink-0 border-b px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-1.5">
          <div className="relative min-w-0 flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
            <Input
              value={typed}
              onChange={(e) => {
                setTyped(e.target.value);
                setPage(null);
                setBack([]);
              }}
              placeholder={
                mode === "inbox"
                  ? "Search this mailbox — from:, has:attachment, \"a phrase\""
                  : "Search is Gmail's; this list is Resend's"
              }
              disabled={mode === "sent"}
              className="h-8 pl-8 text-[13.5px]"
              aria-label="Search mail"
            />
          </div>
          <Button variant="ghost" size="icon-sm" disabled={refreshing} aria-label="Refresh mail" title="Refresh mail" onClick={refreshMail}>
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
        </div>
        {mode === "inbox" && threads.data?.readAt && <p className="text-muted-foreground mt-1 text-[11px]" role="status">
          {refreshing ? "Updating…" : `Updated ${ago(threads.data.readAt)}`}
        </p>}

        {/* The chips. Horizontal scroll rather than wrap: ten domains wrapped
            onto three lines is a third of the list pane spent on a filter. */}
        <div className="mt-2 flex items-center gap-1 overflow-x-auto pb-0.5">
          <Chip active={!chip} onClick={() => put("mailbox", null)} label="All" />
          {domains.map((m) => (
            <Chip
              key={m.key}
              active={chip === m.key}
              onClick={() => put("mailbox", chip === m.key ? null : m.key)}
              label={label(m.key)}
              title={
                m.domain
                  ? `to:(@${m.domain})${m.status ? ` · ${m.status} on Resend` : ""}`
                  : undefined
              }
            />
          ))}
          {chips.data?.gmail && mode === "inbox" && (
            <Chip
              active={chip === "gmail"}
              onClick={() => put("mailbox", chip === "gmail" ? null : "gmail")}
              label={chips.data.gmail.address ?? "Gmail"}
              title={`to:(${chips.data.gmail.address ?? ""})`}
            />
          )}
        </div>
      </div>

      {/* THE FIRST OF THE TWO SCROLLERS. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <ListNote
            title="That did not work"
            body={error}
            action={
              mode === "inbox"
                ? { to: "/integrations/gmail", label: "Check the Gmail integration" }
                : { to: "/integrations/resend", label: "Check the Resend keys" }
            }
          />
        ) : loading ? (
          <ListNote title="Reading…" body="Every row is a thread Gmail has to be asked about by name, so a page takes a second or two." />
        ) : mode === "inbox" ? (
          rows.length ? (
            rows.map((t) => (
              <ThreadRow
                key={t.id}
                thread={t}
                unread={readNow[t.id] ?? t.unread}
                active={open?.kind === "thread" && open.id === t.id}
                badge={t.mailbox ? label(t.mailbox) : null}
                onOpen={() => setOpen({ kind: "thread", id: t.id })}
              />
            ))
          ) : (
            <ListNote
              title="Nothing matches"
              body={`Gmail was asked for “${threads.data?.query ?? ""}” and answered with no threads.`}
            />
          )
        ) : sentRows.length ? (
          sentRows.map((e) => (
            <SentRow
              key={`${e.domain}:${e.id}`}
              row={e}
              label={label(e.domain)}
              active={open?.kind === "sent" && open.id === e.id}
              onOpen={() => setOpen({ kind: "sent", id: e.id, domain: e.domain })}
            />
          ))
        ) : (
          <ListNote
            title="Nothing sent"
            body="No connected Resend key reports an email in its most recent page."
          />
        )}

        {mode === "sent" && !!sent.data?.restricted.length && (
          <ListNote
            title="Some keys cannot be read"
            body={`${sent.data.restricted.join(", ")} — the key is restricted to sending, so what it sent cannot be read back. That is not the same as having sent nothing.`}
          />
        )}
        {mode === "inbox" && threads.data?.mailboxIgnored && (
          <ListNote
            title="That filter was ignored"
            body={`No connected key covers ${threads.data.mailboxIgnored}, so the whole mailbox is shown rather than an empty list.`}
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
        <div className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-[14px]">
          <div className="max-w-[320px]">
            Pick a {mode === "inbox" ? "conversation" : "message"} to read it.
            <div className="mt-1.5 text-[12.5px]">
              Nothing on this page is written down — every subject and body is
              read from {mode === "inbox" ? "Gmail" : "Resend"} the moment you
              ask for it.
            </div>
          </div>
        </div>
      ) : open.kind === "thread" ? (
        <ThreadReader
          key={open.id}
          id={open.id}
          onBack={() => setOpen(null)}
          onRead={markedRead}
          venture={label}
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

/* ====================================================================== */
/*  Time                                                                  */
/* ====================================================================== */

/** A list column, so it has to be short and has to sort visually. Today is a
 *  clock, this year is a date, older carries the year — which is how every
 *  mail client anybody has used behaves, and the reason is that "14:02" and
 *  "3 Mar 2024" answer two different questions. */
function listTime(ms: number | null): string {
  if (!ms) return "";
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString())
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return day(d, { year: d.getFullYear() !== now.getFullYear() });
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
  onClick,
}: {
  active: boolean;
  label: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "text-muted-foreground hover:bg-accent hover:text-foreground shrink-0 rounded-full border px-2.5 py-[3px] text-[12.5px] whitespace-nowrap",
        active && "bg-foreground text-background border-foreground",
      )}
    >
      {label}
    </button>
  );
}

function ThreadRow({
  thread: t,
  unread,
  active,
  badge,
  onOpen,
}: {
  thread: MailThread;
  unread: boolean;
  active: boolean;
  /** The venture this arrived at, or null. NO BADGE FOR GMAIL AND NONE FOR
   *  "none of ours": a badge on every row is a column, and a column reading
   *  "Gmail" two hundred times is noise. The badge answers "why is this in my
   *  inbox", which only a venture address raises. */
  badge: string | null;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "hover:bg-accent/60 flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left",
        active && "bg-accent",
      )}
    >
      <div className="flex w-full items-baseline gap-2">
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13.5px]",
            unread ? "text-foreground font-semibold" : "text-foreground/90",
          )}
          title={t.from}
        >
          {t.fromName || t.from || "(no sender)"}
          {t.messages > 1 && (
            <span className="text-muted-foreground font-normal"> ({t.messages})</span>
          )}
        </span>
        <span className="text-muted-foreground shrink-0 font-mono text-[11.5px] tabular-nums">
          {listTime(t.at)}
        </span>
      </div>
      <div className="flex w-full items-baseline gap-1.5">
        {badge && (
          <span
            className="text-muted-foreground shrink-0 rounded-[5px] border px-1 py-px text-[11px]"
            title={`Addressed to ${t.mailbox}`}
          >
            {badge}
          </span>
        )}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px]",
            unread ? "font-medium" : "text-foreground/80",
          )}
        >
          {t.subject || "(no subject)"}
        </span>
      </div>
      {t.snippet && (
        <span className="text-muted-foreground w-full truncate text-[12px]">
          {t.snippet}
        </span>
      )}
    </button>
  );
}

function SentRow({
  row,
  label,
  active,
  onOpen,
}: {
  row: { id: string; domain: string; at: string; to: string[]; subject: string; lastEvent: string | null };
  label: string;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "hover:bg-accent/60 flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left",
        active && "bg-accent",
      )}
    >
      <div className="flex w-full items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-[13.5px]" title={row.to.join(", ")}>
          {row.to[0] ?? "(no recipient)"}
          {row.to.length > 1 && (
            <span className="text-muted-foreground"> +{row.to.length - 1}</span>
          )}
        </span>
        <span className="text-muted-foreground shrink-0 font-mono text-[11.5px] tabular-nums">
          {listTime(Date.parse(row.at) || null)}
        </span>
      </div>
      <div className="flex w-full items-baseline gap-1.5">
        <span className="text-muted-foreground shrink-0 rounded-[5px] border px-1 py-px text-[11px]">
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px]">
          {row.subject || "(no subject)"}
        </span>
      </div>
      {/* Resend's own word, never reduced to a tick or a cross: "queued" is not
          "delivered" and neither is a failure. */}
      <span
        className={cn(
          "text-muted-foreground text-[12px]",
          row.lastEvent === "bounced" && "text-destructive",
          row.lastEvent === "complained" && "text-warn",
        )}
      >
        {row.lastEvent ?? "no event reported"}
      </span>
    </button>
  );
}

/* ====================================================================== */
/*  The reader                                                            */
/* ====================================================================== */

/**
 * One thread.
 *
 * MARKING READ HAPPENS AFTER A DWELL, NOT ON CLICK. A click is often a
 * mis-click, and a mail client that consumes the unread flag the instant a row
 * is touched is one you stop trusting to open anything. A second and a half of
 * the thread actually being on screen is the signal; the timer is cancelled if
 * the thread closes first, so arrowing past three conversations marks none of
 * them.
 *
 * It is also the ONE WRITE this dashboard makes anywhere. The button beside it
 * puts the flag back, because a state you can only ever consume is a state you
 * cannot correct.
 */
function ThreadReader({
  id,
  onBack,
  onRead,
  venture,
}: {
  id: string;
  onBack: () => void;
  onRead: (id: string, unread: boolean) => void;
  venture: (key: string | null) => string;
}) {
  const account = Number(new URLSearchParams(window.location.search).get("account")) || undefined;
  const thread = useApi(() => api.mailboxThread(id, { account }), [id, account]);
  /** Which message's remote images have been asked for. One at a time: the
   *  server re-reads the thread to answer, and "load them all" on a nineteen-
   *  message thread is a decision about eighteen messages nobody looked at. */
  const [images, setImages] = useState<string | null>(null);
  const [unread, setUnread] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const doc = useApi(
    async () => (images ? await api.mailboxThread(id, { images, account }) : null),
    [id, account, images],
  );
  const shown = images && doc.data ? doc.data : thread.data;

  const isUnread = unread ?? shown?.messages.some((m) => m.unread) ?? false;

  const setRead = useCallback(
    async (next: boolean) => {
      setBusy(true);
      setFailed(null);
      try {
        await api.mailboxMarkRead(id, next, account);
        setUnread(next);
        onRead(id, next);
      } catch (e) {
        /* A failed write says so and changes nothing. Flipping the row anyway
           would show a state Gmail does not hold, which is the one lie a mail
           client must not tell. */
        setFailed(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [id, account, onRead],
  );

  useEffect(() => {
    if (!thread.data) return;
    if (!thread.data.messages.some((m) => m.unread)) return;
    const t = setTimeout(() => void setRead(false), 1500);
    return () => clearTimeout(t);
    // `setRead` is stable per thread; the dwell is about this thread arriving.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thread.data]);

  if (thread.error)
    return <ReaderNote onBack={onBack} title="That thread would not open" body={thread.error} />;
  if (thread.loading || !shown)
    return <ReaderNote onBack={onBack} title="Reading…" body="Gmail is being asked for the whole conversation." />;

  return (
    <>
      <header className="flex flex-wrap shrink-0 items-start gap-2 border-b px-3.5 py-2.5">
        <Link className="border rounded px-2 py-1 text-xs" to="/mail/outbox" state={{ reply: { to: shown.messages.findLast(m => !m.labels.includes("SENT"))?.from ?? shown.messages.at(-1)?.to.split(",")[0] ?? "", subject: /^re:/i.test(shown.subject) ? shown.subject : `Re: ${shown.subject}`, account: shown.accountId, thread: id, back: `/mail/inbox?thread=${encodeURIComponent(id)}&account=${shown.accountId}` } }}>Draft reply</Link>
        <button
          type="button"
          onClick={onBack}
          className="hover:bg-accent text-muted-foreground -ml-1 shrink-0 rounded-md p-1 md:hidden"
          aria-label="Back to the list"
        >
          <ArrowLeft className="size-4" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[16px] font-normal tracking-[-0.01em]">
            {shown.subject || "(no subject)"}
          </h2>
          <p className="text-muted-foreground mt-0.5 text-[12.5px]">
            {shown.messages.length} {shown.messages.length === 1 ? "message" : "messages"}
            {shown.mailbox && ` · ${venture(shown.mailbox)}`}
            {failed && <span className="text-destructive"> · {failed}</span>}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void setRead(!isUnread)}
          className="hover:bg-accent text-muted-foreground flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-[12.5px] disabled:opacity-50"
          title={
            isUnread
              ? "Remove the UNREAD label in Gmail"
              : "Put the UNREAD label back in Gmail — the only write this dashboard makes"
          }
        >
          {isUnread ? <Mail className="size-3.5" /> : <MailOpen className="size-3.5" />}
          {isUnread ? "Mark read" : "Mark unread"}
        </button>
      </header>

      {/* THE SECOND OF THE TWO SCROLLERS. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {shown.messages.map((m, i) => (
          <MessageBlock
            key={m.id}
            message={m}
            /* A thread is its latest message plus history. Nineteen alert
               mails rendered as nineteen frames made the thread most worth
               opening the one least readable, so everything already read and
               not last folds to a line. */
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
 * One sent email.
 *
 * NO REPLY AND NO COMPOSE, DELIBERATELY. There is no reply to a password
 * reset: the From address is a robot, the recipient never wrote to it, and a
 * composer here would be a control answering a question nobody asked. The
 * reader is the same one the inbox uses — a bounce is half the story and "what
 * did we actually send them" is the other half — and our own template goes
 * through exactly the same sanitiser, because "we sent it" is not a property a
 * renderer can lean on.
 */
function SentReader({ domain, id, onBack }: { domain: string; id: string; onBack: () => void }) {
  const [images, setImages] = useState(false);
  const email = useApi(() => api.mailboxSentEmail(domain, id, images), [domain, id, images]);

  if (email.error)
    return <ReaderNote onBack={onBack} title="That message would not open" body={email.error} />;
  if (email.loading || !email.data)
    return <ReaderNote onBack={onBack} title="Reading…" body="Resend is being asked for the body." />;

  const e: SentEmailDoc = email.data;
  /* Shaped into the inbox's message so one component renders both. The fields
     Resend has no answer for are absent rather than invented: no labels, never
     unread, no Gmail id. */
  const asMessage: MailMessage = {
    id: e.id,
    messageId: e.messageId,
    from: e.from,
    fromName: "",
    to: e.to.join(", "),
    cc: e.cc.join(", "),
    subject: e.subject,
    at: Date.parse(e.at) || null,
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
          <h2 className="truncate text-[16px] font-normal tracking-[-0.01em]">
            {e.subject || "(no subject)"}
          </h2>
          <p className="text-muted-foreground mt-0.5 text-[12.5px]">
            {e.domain} · {e.lastEvent ?? "no event reported"} · sent, not received —
            there is no reply to a password reset
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
          {listTime(m.at)}
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
          This message has no text and no HTML part.
        </p>
      )}

      <footer className="text-muted-foreground mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        {m.html && (
          <button
            type="button"
            onClick={() => setPlain((p) => !p)}
            className="hover:text-foreground underline-offset-2 hover:underline"
          >
            {plain ? "Rich version" : "Plain text"}
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
            {imagesBusy
              ? "loading…"
              : `Load ${m.remoteImages} remote ${m.remoteImages === 1 ? "image" : "images"}`}
          </button>
        )}
        {m.imagesLoaded && m.remoteImages > 0 && (
          <span>{m.remoteImages} remote images loaded</span>
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
          <p className="text-muted-foreground mt-1.5 text-[13px] leading-relaxed">{body}</p>
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

