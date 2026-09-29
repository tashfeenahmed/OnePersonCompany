import { Link } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronsRight,
  Clock,
  Layers,
  List,
  Loader2,
  Mail,
  Pencil,
  RefreshCw,
  Reply,
  RotateCcw,
  Send,
  Trash2,
  Undo2,
} from "lucide-react";
import { ago, day } from "@/lib/format";
import { decodeEntities, mailTime, plural, senderName, TRIAGE_LABELS, type TriageKey } from "@/lib/mailText";
import { Avatar, EmptyState, FilterChips, Problem, SmallPrint, TriageChip, VentureTag, type FilterChip } from "./parts";
import { PageShell } from "@/components/PageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import {
  mailflowApi,
  type MailThreadDoc,
  type OutboxItem,
  type TriageDoc,
  type TriageThread,
} from "@/lib/api/mailflow";

/**
 * PRIORITY (route /mail/triage) — the last few days of the inbox, sorted by an
 * AI pass into Needs reply, Waiting on them, FYI and Newsletter.
 *
 * TWO VIEWS OF ONE SET OF ROWS. The list is the default: it reads like an
 * inbox, with filter chips for each group (plus Done and Snoozed, which can be
 * undone) and Reply / Done / Tomorrow as buttons on every row. "One at a time"
 * is the deck: one email on the table with Skip, Done, Tomorrow and Reply with
 * AI under it, which moves only when one is pressed. The choice is remembered
 * in this browser.
 *
 * NOT SORTED IS SHOWN, NEVER HIDDEN. A thread the AI has not read yet has its
 * own group; folding it into Newsletter would hide mail nobody looked at.
 *
 * DONE AND TOMORROW CHANGE THIS LIST AND NOTHING IN GMAIL.
 *
 * REPLY WITH AI is the one thing here that reads message bodies, and the server
 * drops what it read with the request. What it writes lands in a textarea;
 * sending goes through the Outbox's own approve → send, see `queue()`.
 *
 * THE LIST IS A CACHE kept by a background pass every half hour, so the page
 * says when it was last sorted, and polls only while a pass is running.
 */

/** How often the page re-reads WHILE a pass is in flight. Four seconds is
 *  about one model batch, so rows appear in the groups roughly as they are
 *  scored. */
const POLL_MS = 4_000;

/** How long the top card's exit slide runs before the deck advances under it.
 *  Just under the transition, so the card is gone before it stops moving. */
const EXIT_MS = 220;

/**
 * THE LAST DOCUMENT, FOR AN INSTANT FIRST PAINT.
 *
 * The fetch is fast now, but "fast" over a network is still a frame of empty
 * page, and this list is the first thing the owner reads in the morning. So
 * the last one is kept in this browser and drawn immediately, then replaced
 * the moment the real answer lands.
 *
 * ONE KEY, NOT ONE PER MAILBOX: this page always asks for the default
 * account, and the document names which one it got, so a second mailbox would
 * replace the entry rather than be confused with it. Every access is wrapped —
 * private windows, blocked storage and a half-written entry all have to end as
 * "no cache" rather than as a page that will not render.
 */
const REMEMBERED = "opc.triage.document";

/** Which of the two views was last used. Same wrapping, same reasoning, and a
 *  missing or unreadable value means the deck — the default. */
const VIEW_KEY = "opc.triage.layout";

function remembered(): TriageDoc | null {
  try {
    const raw = localStorage.getItem(REMEMBERED);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TriageDoc;
    return parsed && typeof parsed === "object" && parsed.groups ? parsed : null;
  } catch {
    return null;
  }
}

function remember(doc: TriageDoc): void {
  try {
    localStorage.setItem(REMEMBERED, JSON.stringify(doc));
  } catch {
    /* Full, blocked, or a private window. The page is fine without it. */
  }
}

type View = "deck" | "list";

function rememberedView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === "deck" ? "deck" : "list";
  } catch {
    return "list";
  }
}

/** "in 26 min" for the next pass. Null where there is no timer to describe —
 *  which is honest rather than a guess at when it might run. */
function until(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return "due now";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "in under a minute";
  return mins < 60 ? `in ${mins} min` : `in ${Math.round(mins / 60)}h`;
}

/** A thrown ApiError carries the server's own sentence. It is worth printing
 *  verbatim — every refusal on this page was written to be read. */
const said = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The groups, in the order both views rank them. Labels live in
 *  lib/mailText so the Inbox chips and this page say the same words. */
const GROUPS: { key: TriageKey; label: string; hint: string; tone: string }[] = (
  ["needs_reply", "waiting_on_them", "fyi", "noise", "unscored"] as const
).map((key) => ({
  key,
  label: TRIAGE_LABELS[key].label,
  hint: TRIAGE_LABELS[key].hint,
  tone: { bad: "bg-destructive", warn: "bg-warn", ok: "bg-ok", muted: "bg-muted-foreground/40" }[TRIAGE_LABELS[key].tone],
}));

/* ==================================================================== */
/*  The deck's ordering                                                 */
/* ==================================================================== */

/**
 * THE DEAL ORDER IS THE LIST'S OWN ORDER, read off the same array the list
 * draws its sections from. That is deliberate rather than convenient: two
 * views of one set of rows that ranked them differently would be two opinions
 * about what matters, and the owner would have to hold both. So the group rank
 * IS the index in `GROUPS` — needs a reply, waiting on them, worth knowing,
 * noise, not scored — and changing that array moves both views at once.
 *
 * Inside a group, urgency first and then newest first. Urgency is the model's
 * and `null` sits with "normal": unranked is neither urgent nor dismissable,
 * and burying it under the low-urgency mail would hide exactly the thread
 * nothing judged.
 *
 * NOISE IS LEFT OUT BY DEFAULT AND IS NOT DELETED. A deck exists to be
 * finished, and forty receipts between two real emails is how it stops being
 * finished; the chip puts them back, and the counter says how many are being
 * held out so the omission is a stated one.
 */
const URGENCY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };

function deckOrder(
  groups: Record<string, TriageThread[]>,
  includeNoise: boolean,
): TriageThread[] {
  const out: TriageThread[] = [];
  for (const g of GROUPS) {
    if (g.key === "noise" && !includeNoise) continue;
    const rows = [...(groups[g.key] ?? [])];
    rows.sort((a, b) => {
      const ua = URGENCY_RANK[a.urgency ?? "normal"] ?? 1;
      const ub = URGENCY_RANK[b.urgency ?? "normal"] ?? 1;
      if (ua !== ub) return ua - ub;
      return (b.at ?? 0) - (a.at ?? 0);
    });
    out.push(...rows);
  }
  return out;
}

/* ==================================================================== */
/*  The reply, one phase at a time                                      */
/* ==================================================================== */

/**
 * WHAT THE CARD IS DOING ABOUT A REPLY, and the shape says where the consent
 * lives. `ready` is words in a textarea and nothing else — no row, no queue,
 * nothing addressed. `queued` means an Outbox draft exists and is inert.
 * `approved` means the owner has said the words are right. Only `sending`
 * touches a mailbox, and it is reached exactly the way the Outbox page reaches
 * it. Discarding at `ready` costs nothing; discarding later dismisses the row,
 * which is the Outbox's own verb and keeps the per-address floor honest.
 */
type Reply =
  | { phase: "idle" }
  | { phase: "drafting" }
  | { phase: "failed"; error: string }
  | {
      phase: "ready";
      to: string;
      subject: string;
      body: string;
      /** The RFC Message-ID the server read off the thread. SHOWN, never sent
       *  on: the Outbox takes a Gmail thread id and derives the header itself.
       *  Held so the card can say the reply will thread. */
      inReplyTo: string | null;
      model: string | null;
      venture: string | null;
    }
  | { phase: "queued"; item: OutboxItem }
  | { phase: "sending"; item: OutboxItem }
  | { phase: "sent"; note: string };

/* ==================================================================== */
/*  The deck                                                            */
/* ==================================================================== */

/**
 * THE DECK — one thread on the table, and it moves when a verb is pressed.
 *
 * IT ADVANCES BY IDENTITY, NOT BY INDEX. A numeric cursor into the ordered
 * list breaks the moment a poll lands mid-session: rows arrive, a score lands
 * and promotes a thread past the one being read, and an index then either
 * repeats the card that slid under it or skips the one that slid into its
 * place. A set of ids already dealt with cannot be shifted by churn — the top
 * card is simply the first row not yet in it.
 *
 * AND THE TOP CARD IS PINNED BY ID. Same problem one level up: with `top =
 * remaining[0]` the card being read would be shoved aside mid-sentence by
 * whatever the next poll ranks higher. Whichever card reaches the table stays
 * there until a verb is pressed; churn reorders the stack underneath it. If
 * the pinned card leaves the document entirely — done on the phone, aged out
 * of the window — the pin falls to the new first card, the one case where a
 * swap is the truth.
 *
 * `dealt` IS SESSION-ONLY ON PURPOSE. A skipped thread comes back next visit,
 * which is the whole difference between Skip and Done: Skip decides nothing.
 */
function Deck({
  doc,
  accountId,
  requireApproval,
  onSettings,
  act,
}: {
  doc: TriageDoc;
  accountId: number | undefined;
  /** Null until the outbox has been asked. The Send row is not drawn on a
   *  guess — see `send()`. */
  requireApproval: boolean | null;
  onSettings: () => void;
  act: (threadId: string, what: "done" | "snooze") => Promise<string | null>;
}) {
  const [includeNoise, setIncludeNoise] = useState(false);
  const [dealt, setDealt] = useState<ReadonlySet<string>>(new Set());
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  /** Which way the top card is leaving: handled slides left, skipped right. */
  const [leaving, setLeaving] = useState<"handled" | "skip" | null>(null);
  /* The card mid-slide, held as a SNAPSHOT rather than looked up: its id joins
     `dealt` the moment the exit starts, so a poll landing during the slide
     cannot yank the element out from under the animation. */
  const [flying, setFlying] = useState<TriageThread | null>(null);
  const [viewThread, setViewThread] = useState(false);
  const [reply, setReply] = useState<Reply>({ phase: "idle" });
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ordered = useMemo(() => deckOrder(doc.groups, includeNoise), [doc.groups, includeNoise]);
  const remaining = useMemo(() => ordered.filter((t) => !dealt.has(t.id)), [ordered, dealt]);
  const noiseHeld = (doc.groups.noise ?? []).length;

  /* The pin. See the header: it only moves when the card it names is gone. */
  useEffect(() => {
    if (pinnedId === null || !remaining.some((t) => t.id === pinnedId))
      setPinnedId(remaining[0]?.id ?? null);
  }, [remaining, pinnedId]);

  const pinned = remaining.find((t) => t.id === pinnedId) ?? remaining[0] ?? null;
  const top = flying ?? pinned;
  /* The stack under the table's card. While one is flying its id is already
     dealt, so `remaining` IS the under-stack, led by the incoming top. */
  const under = flying ? remaining : remaining.filter((t) => t.id !== pinned?.id);

  /* HOW FAR THROUGH, and the arithmetic has to survive Done removing a row
     from the document. `dealt` counts every card that left the table by any
     verb; `remaining` is what is still coming. Their sum is the deck, and a
     card in flight is already counted as dealt so the number holds through the
     slide rather than flickering. */
  const total = remaining.length + dealt.size;
  const at = Math.min(dealt.size + (flying ? 0 : 1), Math.max(total, 1));

  /* Every timer goes through this so unmounting clears the lot, and the async
     guard is what stops a draft written for a card two verbs ago from opening
     over the wrong mail. */
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const id of timers.current) clearTimeout(id);
    },
    [],
  );
  const topRef = useRef<string | null>(null);
  useEffect(() => {
    topRef.current = top?.id ?? null;
  }, [top]);
  const leavingRef = useRef(false);

  const resetCard = useCallback(() => {
    setViewThread(false);
    setReply({ phase: "idle" });
    setRefused(null);
  }, []);

  /* Turning the noise chip on or off redraws the table. `dealt` SURVIVES it —
     a card dealt with is dealt with — and only the per-card state is cleared,
     because the top card changes identity. */
  useEffect(() => {
    leavingRef.current = false;
    setLeaving(null);
    setFlying(null);
    resetCard();
  }, [includeNoise, resetCard]);

  /** Slide the top card off, then advance. The ref guard is what stops a
   *  double press from dealing two cards with one gesture. */
  const advance = useCallback(
    (dir: "handled" | "skip") => {
      if (leavingRef.current) return;
      /* The card acted on is the PINNED one — the card being looked at — which
         a mid-read re-sort may have moved off `remaining[0]`. */
      const card = pinned;
      if (!card) return;
      leavingRef.current = true;
      setFlying(card);
      setLeaving(dir);
      setDealt((prev) => new Set(prev).add(card.id));
      timers.current.push(
        window.setTimeout(() => {
          leavingRef.current = false;
          setLeaving(null);
          setFlying(null);
          /* Release the pin so it settles on whatever the deck now ranks
             first. */
          setPinnedId(null);
          resetCard();
        }, EXIT_MS),
      );
    },
    [pinned, resetCard],
  );

  const handle = useCallback(
    (what: "done" | "snooze") => {
      const card = pinned;
      if (!card || leavingRef.current) return;
      /* Optimistic, exactly as the list's rows are: the card leaves now and a
         failed write comes back as a sentence rather than as a frozen deck. */
      void act(card.id, what).then((error) => {
        if (error) setRefused(error);
      });
      advance("handled");
    },
    [pinned, act, advance],
  );

  const draftReply = useCallback(async () => {
    const card = pinned;
    if (!card || leavingRef.current || reply.phase === "drafting") return;
    setRefused(null);
    setReply({ phase: "drafting" });
    /* Asked for alongside the draft rather than on mount: the deck is used to
       triage far more often than to answer, and this is a request about the
       Outbox's rules that only a reply needs. */
    onSettings();
    try {
      const draft = await mailflowApi.reply(card.id, { account: accountId });
      /* The deck may have moved on while the model wrote. A draft for a card
         no longer on the table is dropped, never opened over the wrong mail. */
      if (topRef.current !== card.id) return;
      setViewThread(false);
      setReply({
        phase: "ready",
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        inReplyTo: draft.inReplyTo,
        model: draft.model,
        venture: draft.venture,
      });
    } catch (err) {
      if (topRef.current !== card.id) return;
      setReply({ phase: "failed", error: said(err) });
    }
  }, [pinned, reply.phase, accountId, onSettings]);

  /**
   * SENDING, AND THIS FUNCTION HAS NO SEND IN IT.
   *
   * There is exactly one road out of this box and it is the Outbox's: a row is
   * written, the owner approves it, the owner sends it. This page joins that
   * road at the beginning and takes every step of it in the open:
   *
   *   `mailflowApi.draft`   writes the row. Inert, and subject to the queue's
   *                         own refusals — the per-address floor answers 409
   *                         here exactly as it would in the composer, and the
   *                         card prints what it said.
   *   `mailflowApi.approve` the owner saying the words are right. Only drawn
   *                         when the Outbox requires it.
   *   `mailflowApi.send`    the owner saying now. With approval switched off
   *                         the server approves on the way past — which is the
   *                         Outbox's own one-press path, and the reason this
   *                         card can show one button there and two here.
   *
   * WHAT IS NOT DONE: no send that skips approval, no approval implied by
   * anything but a press, and no path at all for the agent — the two routes
   * refuse the skills proxy's header and the skill publishes neither. If the
   * Outbox ever gains a third rule, this card gains it too by construction,
   * because it calls those three functions and holds no copy of the policy.
   *
   * `inReplyTo` IS THE GMAIL THREAD ID, which is what `POST /api/outbox`
   * validates and stores; the server reads the real Message-ID off the thread
   * at send time. The RFC id the drafter handed back is for showing.
   */
  const queue = useCallback(async () => {
    const card = pinned;
    if (!card || reply.phase !== "ready" || busy) return;
    setBusy(true);
    setRefused(null);
    try {
      const { item } = await mailflowApi.draft({
        account: accountId,
        to: reply.to,
        subject: reply.subject,
        body: reply.body,
        inReplyTo: card.id,
        venture: reply.venture,
      });
      if (requireApproval === false) {
        const sent = await mailflowApi.send(item.id, item.approvalKey);
        setReply({ phase: "sent", note: sent.note });
      } else {
        const approved = await mailflowApi.approve(item.id, item.approvalKey);
        setReply({ phase: "queued", item: approved.item });
      }
    } catch (err) {
      setRefused(said(err));
    } finally {
      setBusy(false);
    }
  }, [pinned, reply, busy, accountId, requireApproval]);

  const sendApproved = useCallback(async () => {
    if (reply.phase !== "queued" || busy) return;
    const item = reply.item;
    setBusy(true);
    setRefused(null);
    setReply({ phase: "sending", item });
    try {
      const sent = await mailflowApi.send(item.id, item.approvalKey);
      setReply({ phase: "sent", note: sent.note });
    } catch (err) {
      setRefused(said(err));
      setReply({ phase: "queued", item });
    } finally {
      setBusy(false);
    }
  }, [reply, busy]);

  /* Answered mail is handled mail: the thread comes off this list — which is
     this box's list and not Gmail's — and the deck moves on after a beat, long
     enough for the receipt to be read. */
  const sentPhase = reply.phase === "sent";
  useEffect(() => {
    if (!sentPhase || !pinned) return;
    const card = pinned;
    const id = window.setTimeout(() => {
      void act(card.id, "done");
      advance("handled");
    }, 1_400);
    timers.current.push(id);
    return () => clearTimeout(id);
  }, [sentPhase, pinned, act, advance]);

  const discard = useCallback(async () => {
    if (reply.phase === "queued" && !busy) {
      /* A row exists. Dropping it is the Outbox's own Dismiss, not a delete:
         the row stays, and it still counts against the per-address floor,
         because a dismissal is "not this person, not now". */
      setBusy(true);
      try {
        await mailflowApi.dismiss(reply.item.id);
        setReply({ phase: "idle" });
      } catch (err) {
        setRefused(said(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (reply.phase === "ready" || reply.phase === "failed") setReply({ phase: "idle" });
  }, [reply, busy]);

  /**
   * THE KEYS, AND THEY STOP AT THE EDGE OF A TEXT FIELD.
   *
   * A deck worked with one hand is the whole point of a deck, but a draft is
   * edited with the same hand: `d` inside a textarea must be the letter d.
   * So every handler checks what has focus first, and the composer's own keys
   * are the browser's.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const typing =
        !!el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          el.tagName === "SELECT" ||
          el.isContentEditable);
      if (e.key === "Escape") {
        if (typing) el?.blur();
        else if (reply.phase !== "idle") void discard();
        else if (viewThread) setViewThread(false);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "j" || key === "k" || e.key.startsWith("Arrow")) {
        e.preventDefault();
        advance("skip");
      } else if (key === "d") {
        e.preventDefault();
        handle("done");
      } else if (key === "s") {
        e.preventDefault();
        handle("snooze");
      } else if (key === "r") {
        e.preventDefault();
        void draftReply();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, handle, draftReply, discard, reply.phase, viewThread]);

  /* The deck is finished — the whole point of the screen, so it gets a card
     rather than a shrug, and the count leads because finishing it is the one
     result this page produces. */
  if (!top)
    return (
      <div className="mx-auto flex w-full max-w-[680px] flex-col items-center gap-3 py-16 text-center">
        <span className="bg-ok/15 grid size-9 place-items-center rounded-full">
          <Check className="text-ok size-5" />
        </span>
        <p className="text-[34px] leading-none font-normal tracking-[-0.03em]">{dealt.size}</p>
        <p className="text-muted-foreground max-w-sm text-[13.5px] leading-relaxed">
          {dealt.size === 0
            ? ordered.length === 0 && !includeNoise && noiseHeld > 0
              ? `All clear — only ${plural(noiseHeld, "newsletter")} left, nothing to answer.`
              : "All clear — nothing waiting on you."
            : `All done — you went through ${plural(dealt.size, "email")}.`}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {dealt.size > 0 && (
            <Button size="sm" variant="outline" onClick={() => setDealt(new Set())}>
              <RotateCcw /> Start again
            </Button>
          )}
          <NoiseChip on={includeNoise} held={noiseHeld} toggle={() => setIncludeNoise((v) => !v)} />
        </div>
      </div>
    );

  const drafting = reply.phase === "drafting";
  const composing =
    reply.phase === "ready" ||
    reply.phase === "queued" ||
    reply.phase === "sending" ||
    reply.phase === "sent";

  return (
    <div className="mx-auto w-full max-w-[680px]">
      {refused && <p className="text-destructive mb-3 text-[13.5px]">{refused}</p>}

      {/* The stack, painted back to front — DOM order is the z-order. The
          ghosts are keyed by thread id, so when the deck advances the second
          card is the same element promoted a slot and its transform eases
          forward: what makes this read as a deck rather than as three divs. */}
      <div className="relative h-[min(62vh,500px)]">
        {under[1] && <GhostCard key={under[1].id} depth={2} />}
        {under[0] && <GhostCard key={under[0].id} depth={1} />}
        <article
          key={top.id}
          aria-label={`Email from ${top.fromName || top.from}`}
          className={cn(
            "bg-card border-line-soft absolute inset-0 flex flex-col overflow-hidden rounded-[14px] border shadow-lg",
            "transition duration-200 ease-out",
            /* Handled leaves left, skipped right — the two directions a hand
               would deal them. The fade rides along so the card is gone before
               it stops moving. */
            leaving === "handled" && "-translate-x-[115%] opacity-0",
            leaving === "skip" && "translate-x-[115%] opacity-0",
          )}
        >
          <header className="border-line-soft shrink-0 border-b px-4 pt-3.5 pb-3 sm:px-4.5">
            <div className="flex items-start gap-3">
              <Avatar name={senderName(top.fromName, top.from)} address={top.from} size={36} />
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-baseline gap-2 text-[13.5px]">
                  <span className="min-w-0 truncate font-medium" title={top.from}>
                    {senderName(top.fromName, top.from)}
                    {top.messages > 1 && <span className="text-muted-foreground font-normal"> · {top.messages}</span>}
                  </span>
                  <span className="text-muted-foreground ml-auto shrink-0 text-[12px] tabular-nums">{mailTime(top.at)}</span>
                </p>
                <h2 className="mt-0.5 text-[16.5px] leading-snug tracking-[-0.015em] break-words">
                  {top.subject || "(no subject)"}
                </h2>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  <TriageChip score={top.score} urgency={top.urgency} />
                  {top.ventureName && (
                    <span title={top.ventureBy === "model" ? "Best guess at which venture this is about" : undefined}>
                      <VentureTag ventureId={top.venture} name={`${top.ventureName}${top.ventureBy === "model" ? "?" : ""}`} />
                    </span>
                  )}
                </div>
              </div>
            </div>
          </header>

          {/* The card's own scroller. The verbs below it never move. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-4.5 py-3">
            {composing ? (
              <Composer
                reply={reply}
                requireApproval={requireApproval}
                busy={busy}
                onChange={(next) => setReply(next)}
              />
            ) : (
              <>
                {top.reason && (
                  <p className="text-[13.5px] leading-relaxed">
                    <span className="text-muted-foreground">Why: </span>
                    {top.reason}
                  </p>
                )}
                {top.stale && (
                  <p className="text-warn mt-1 text-[12.5px]">There's a newer reply since this was sorted.</p>
                )}
                <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
                  {decodeEntities(top.snippet) || "(no preview)"}
                </p>

                <div className="border-line-soft mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2.5">
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground -ml-1.5"
                    onClick={() => setViewThread((v) => !v)}
                  >
                    <Mail /> {viewThread ? "Hide the conversation" : "Read the whole conversation"}
                  </Button>
                  <Link
                    className="text-muted-foreground text-[12.5px] underline"
                    to={`/mail/inbox?thread=${encodeURIComponent(top.id)}&account=${top.accountId}`}
                  >
                    Open in Inbox
                  </Link>
                </div>

                {viewThread && <ThreadView key={top.id} threadId={top.id} accountId={accountId} />}

                {drafting && (
                  <p className="text-muted-foreground mt-3 animate-pulse text-[12.5px] leading-relaxed">
                    Writing a reply for you… Nothing is sent.
                  </p>
                )}
                {reply.phase === "failed" && (
                  <p className="text-destructive mt-3 text-[12.5px] leading-relaxed">
                    Couldn't write a reply: {reply.error}
                  </p>
                )}
              </>
            )}
          </div>

          <footer className="border-line-soft flex shrink-0 flex-wrap items-center gap-1.5 border-t px-3.5 py-2.5">
            {composing ? (
              <>
                {reply.phase === "ready" && (
                  <Button size="sm" onClick={() => void queue()} disabled={busy || !reply.to.trim()}>
                    {busy ? <Loader2 className="animate-spin" /> : <Send />}
                    {requireApproval === false ? "Send" : "Approve"}
                  </Button>
                )}
                {reply.phase === "queued" && (
                  <Button size="sm" onClick={() => void sendApproved()} disabled={busy}>
                    {busy ? <Loader2 className="animate-spin" /> : <Send />} Send now
                  </Button>
                )}
                {reply.phase === "sending" && (
                  <Button size="sm" disabled>
                    <Loader2 className="animate-spin" /> Sending…
                  </Button>
                )}
                {reply.phase !== "sent" && (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void discard()}>
                    <Trash2 /> {reply.phase === "queued" ? "Dismiss" : "Discard"}
                  </Button>
                )}
                {reply.phase === "sent" && (
                  <p className="text-ok text-[12.5px]">Sent. Next email…</p>
                )}
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => advance("skip")}
                  title="Leave it for now. It comes back next time. (j)"
                >
                  <ChevronsRight /> Skip
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handle("done")}
                  title="Take it off this list. Gmail is not changed. (d)"
                >
                  <Check /> Done
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handle("snooze")}
                  title="Hide it until tomorrow. Gmail is not changed. (s)"
                >
                  <Clock /> Tomorrow
                </Button>
                <Button
                  size="sm"
                  onClick={() => void draftReply()}
                  disabled={drafting}
                  title="AI writes a reply you can edit. Nothing sends without you. (r)"
                >
                  {drafting ? <Loader2 className="animate-spin" /> : <Pencil />}
                  {drafting ? "Writing…" : "Reply with AI"}
                </Button>
              </>
            )}
            {/* How far through, as a mark and as the figure it stands for. The
                bar is the glance — "am I nearly done" is a question a counter
                answers slowly — and the numerals stay the fact beside it. */}
            <p
              aria-live="polite"
              className="text-muted-foreground ml-auto flex shrink-0 items-center gap-2 text-[12.5px] tabular-nums"
            >
              <span className="bg-muted hidden h-1 w-16 overflow-hidden rounded-full sm:block">
                <span
                  className="bg-primary/70 block h-full transition-[width] duration-200"
                  style={{ width: `${(at / Math.max(total, 1)) * 100}%` }}
                />
              </span>
              {at} of {total}
            </p>
          </footer>
        </article>
      </div>

      {/* Clear of the ghost that hangs below the table's card. */}
      <div className="mt-6 flex flex-wrap items-center gap-1.5">
        <NoiseChip on={includeNoise} held={noiseHeld} toggle={() => setIncludeNoise((v) => !v)} />
        {dealt.size > 0 && (
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => setDealt(new Set())}
          >
            <RotateCcw /> Start again
          </Button>
        )}
        <span className="text-muted-foreground/70 ml-auto hidden text-[12px] sm:inline">
          Keys: j skip · d done · s tomorrow · r reply · Esc cancel
        </span>
      </div>
    </div>
  );
}

/**
 * A card behind the top one, and it says nothing.
 *
 * It is a real thread — keyed by its id, so when the deck advances the second
 * ghost is the same element promoted a slot and eases forward, which is what
 * makes this read as a deck rather than as three divs. What it deliberately
 * does NOT do is show that thread's sender and subject. Only its bottom edge
 * is ever visible, and a card face peeking out from under the one being
 * decided on is the next thread arguing for attention while this one still has
 * it. The stack is here to say "there is more", which is a shape, not a
 * sentence.
 */
function GhostCard({ depth }: { depth: 1 | 2 }) {
  /* SCALED FROM THE TOP AND PUSHED DOWN, and the two numbers are paired
     rather than chosen. A card scaled about its centre loses half its shrink
     off the bottom, which cancelled the offset exactly — the first draft of
     this drew three cards stacked so perfectly that the deck looked like one.
     With `origin-top` the top edge is pinned, the shrink comes entirely off
     the bottom, and the translate is what is left over as the visible sliver.
     Transform rather than inset because transform is what transitions: the
     second card IS the same element promoted a slot, and it eases forward. */
  return (
    <div
      aria-hidden="true"
      className={cn(
        "bg-card border-line-soft pointer-events-none absolute inset-0 origin-top overflow-hidden rounded-[14px] border",
        "transition duration-200 ease-out",
        depth === 1
          ? "translate-y-[26px] scale-[.97] opacity-70"
          : "translate-y-[52px] scale-[.94] opacity-40",
      )}
    />
  );
}

/** The chip that puts noise back in the deck. A narrowing rather than a mode
 *  switch, so it is drawn as one — no track, no fill, the count in the label
 *  so leaving it out is a stated omission rather than a silent one. */
function NoiseChip({ on, held, toggle }: { on: boolean; held: number; toggle: () => void }) {
  if (!held && !on) return null;
  return (
    <Button
      size="xs"
      variant={on ? "outline" : "ghost"}
      aria-pressed={on}
      className={on ? undefined : "text-muted-foreground"}
      onClick={toggle}
      title="Newsletters, alerts and receipts are skipped unless you ask for them."
    >
      {on ? "Hide newsletters" : `Also show ${plural(held, "newsletter")}`}
    </Button>
  );
}

/**
 * THE THREAD, INLINE, THROUGH THE MAILBOX APP'S OWN READER. `/api/mailbox` is
 * a live proxy that stores nothing — no cache, no row, no log — and this card
 * borrows it rather than growing a second reader, so there stays one place
 * where mail is fetched and one place where its markup is sanitised.
 *
 * PLAIN TEXT ONLY, HERE. The mailbox page renders HTML mail inside a sandboxed
 * frame carrying its own CSP, and reproducing that machinery in a triage card
 * would be a second copy of the one thing on this dashboard that must not have
 * two versions. A message with no text part therefore says so and points at
 * the reader that can draw it, which is the honest half of the trade: what is
 * shown here is what the sender actually typed.
 */
function ThreadView({ threadId, accountId }: { threadId: string; accountId: number | undefined }) {
  const [state, setState] = useState<{
    loading: boolean;
    doc: MailThreadDoc | null;
    error: string | null;
  }>({ loading: true, doc: null, error: null });

  useEffect(() => {
    let live = true;
    setState({ loading: true, doc: null, error: null });
    mailflowApi
      .thread(threadId, accountId)
      .then((doc) => {
        if (live) setState({ loading: false, doc, error: null });
      })
      .catch((err: unknown) => {
        if (live) setState({ loading: false, doc: null, error: said(err) });
      });
    return () => {
      live = false;
    };
  }, [threadId, accountId]);

  if (state.loading)
    return (
      <p className="text-muted-foreground mt-2 text-[12.5px]">
        <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
        Opening the conversation…
      </p>
    );
  if (state.error)
    return (
      <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
        It wouldn't open — <span className="text-destructive">{state.error}</span>
      </p>
    );

  const messages = state.doc?.messages ?? [];
  /* The last four, oldest first. A long thread's beginning is rarely what the
     answer turns on, and the count says what is not being shown. */
  const shown = messages.slice(-4);
  return (
    <div className="mt-2 flex flex-col gap-2.5">
      {messages.length > shown.length && (
        <p className="text-muted-foreground/70 text-[12.5px]">
          The last {shown.length} of {messages.length} messages. Open in Inbox for the rest.
        </p>
      )}
      {shown.map((m) => (
        <div key={m.id} className="border-line-soft rounded-[10px] border px-3 py-2">
          <p className="text-muted-foreground flex flex-wrap items-baseline gap-x-2 text-[12.5px]">
            <span className="font-medium">{m.fromName || m.from}</span>
            <span className="ml-auto tabular-nums">{ago(m.at, { nullText: "no date" })}</span>
          </p>
          {m.text.trim() ? (
            <p className="mt-1 max-h-56 overflow-y-auto text-[13px] leading-relaxed whitespace-pre-wrap">
              {m.text.trim()}
            </p>
          ) : (
            <p className="text-muted-foreground/70 mt-1 text-[12.5px] italic">
              This one has no plain text — open it in Inbox to see it.
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * THE DRAFT, IN THE CARD, EDITABLE — and it is words and nothing else until a
 * button is pressed. `to` is drawn rather than typed: it is the address the
 * server read off the newest message the owner did not send, and re-typing a
 * recipient inside a triage card is how a reply reaches the wrong person.
 * Change it in the Outbox composer, where the queue's own checks are.
 */
function Composer({
  reply,
  requireApproval,
  busy,
  onChange,
}: {
  reply: Reply;
  requireApproval: boolean | null;
  busy: boolean;
  onChange: (next: Reply) => void;
}) {
  if (reply.phase === "sent")
    return (
      <div className="text-[13.5px] leading-relaxed">
        <p className="text-ok font-medium">Sent.</p>
        <p className="text-muted-foreground mt-1 text-[12.5px] leading-relaxed">{reply.note}</p>
      </div>
    );

  if (reply.phase === "queued" || reply.phase === "sending")
    return (
      <div className="text-[13.5px]">
        <p className="text-muted-foreground text-[12.5px] leading-relaxed">
          {reply.phase === "sending"
            ? "Leaving now."
            : "Approved — not sent yet. Press Send now when you're ready, or Dismiss to drop it."}
        </p>
        <p className="text-muted-foreground mt-2 text-[12.5px]">
          To <span className="text-foreground">{reply.item.to}</span>
          {reply.item.from && (
            <>
              {" · from "}
              <span className="text-foreground">{reply.item.from}</span>
            </>
          )}
        </p>
        <p className="mt-1 text-[14px]">{reply.item.subject}</p>
        {/* `preview` is the markdown WITH the signature setting under it —
            what the recipient actually receives. Drawing `body` here would
            mean the document approved is not the document that goes out. */}
        <p className="mt-2 leading-relaxed whitespace-pre-wrap">{reply.item.preview}</p>
        {reply.item.fromError && (
          <p className="text-destructive mt-2 text-[12.5px] leading-relaxed">
            {reply.item.fromError}
          </p>
        )}
        {reply.item.fromWarning && (
          <p className="text-warn mt-2 text-[12.5px] leading-relaxed">{reply.item.fromWarning}</p>
        )}
      </div>
    );

  if (reply.phase !== "ready") return null;

  return (
    <div>
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">
        A reply written for you — edit anything, then{" "}
        {requireApproval === false ? "press Send." : "press Approve, then Send now."} Nothing
        sends until you do.
      </p>
      <p className="text-muted-foreground mt-2.5 text-[12.5px]">
        To <span className="text-foreground">{reply.to}</span>
        {reply.inReplyTo && " · as a reply in this conversation"}
      </p>
      <label className="mt-2 block">
        <span className="text-muted-foreground text-[12.5px]">Subject</span>
        <Input
          className="mt-1"
          value={reply.subject}
          disabled={busy}
          onChange={(e) => onChange({ ...reply, subject: e.target.value })}
        />
      </label>
      <label className="mt-2 block">
        <span className="text-muted-foreground text-[12.5px]">Message</span>
        <Textarea
          className="mt-1 min-h-44 resize-y leading-relaxed"
          rows={9}
          value={reply.body}
          disabled={busy}
          onChange={(e) => onChange({ ...reply, body: e.target.value })}
        />
      </label>
      <p className="text-muted-foreground/70 mt-1.5 text-[12px] leading-relaxed">
        Your signature is added underneath.
      </p>
    </div>
  );
}

/* ==================================================================== */
/*  The list                                                            */
/* ==================================================================== */

type RowMode = "active" | "done" | "snoozed";

/**
 * One thread in the list, laid out like an inbox row: who, when, what, a
 * one-line preview, the sorter's chip and its reason — and the actions as
 * real buttons (not hover-only, so they work on a phone). Clicking the row
 * opens the email in the Inbox reader.
 */
function Row({
  t,
  busy,
  mode,
  onDone,
  onSnooze,
  onUndo,
}: {
  t: TriageThread;
  busy: boolean;
  mode: RowMode;
  onDone: () => void;
  onSnooze: () => void;
  onUndo: () => void;
}) {
  const name = senderName(t.fromName, t.from);
  const open = `/mail/inbox?thread=${encodeURIComponent(t.id)}&account=${t.accountId}`;
  const reply = {
    to: t.from,
    subject: /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`,
    account: t.accountId,
    thread: t.id,
    venture: t.venture,
    back: "/mail/triage",
  };
  return (
    <div className="border-line-soft flex items-start gap-3 border-b px-3 py-3 last:border-b-0 sm:px-4">
      <Link to={open} className="mt-0.5 shrink-0" tabIndex={-1} aria-hidden>
        <Avatar name={name} address={t.from} size={34} />
      </Link>
      <div className="min-w-0 flex-1">
        <Link to={open} className="group block min-w-0">
          <span className="flex items-baseline gap-2">
            {t.unread && <span className="bg-primary size-2 shrink-0 self-center rounded-full" aria-label="Unread" />}
            <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", t.unread ? "font-semibold" : "text-foreground/90")} title={t.from}>
              {name}
              {t.messages > 1 && <span className="text-muted-foreground font-normal"> · {t.messages}</span>}
            </span>
            <span className="text-muted-foreground shrink-0 text-[11.5px] tabular-nums">{mailTime(t.at)}</span>
          </span>
          <span className={cn("mt-0.5 block truncate text-[13.5px] group-hover:underline", t.unread && "font-medium")}>
            {t.subject || "(no subject)"}
          </span>
          {t.snippet && <span className="text-muted-foreground mt-0.5 block truncate text-[12.5px]">{decodeEntities(t.snippet)}</span>}
        </Link>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <TriageChip score={t.score} urgency={t.urgency} />
          {t.ventureName && (
            <span title={t.ventureBy === "model" ? "Best guess at which venture this is about" : undefined}>
              <VentureTag ventureId={t.venture} name={`${t.ventureName}${t.ventureBy === "model" ? "?" : ""}`} />
            </span>
          )}
          {mode === "snoozed" && t.snoozedUntil && (
            <span className="text-muted-foreground text-[12px]">Back {day(t.snoozedUntil, { long: false })}</span>
          )}
          {t.reason && mode === "active" && (
            <span className="text-muted-foreground min-w-0 basis-full truncate text-[12.5px] italic sm:basis-auto sm:flex-1">
              {t.reason}
            </span>
          )}
        </div>
        {t.stale && mode === "active" && (
          <p className="text-warn mt-1 text-[12px]">There's a newer reply since this was sorted.</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {mode === "active" && (
            <>
              <Button size="xs" asChild>
                <Link to="/mail/outbox" state={{ reply }}>
                  <Reply /> Reply
                </Link>
              </Button>
              <Button size="xs" variant="outline" disabled={busy} onClick={onDone} title="Take it off this list. Gmail is not changed.">
                <Check /> Done
              </Button>
              <Button size="xs" variant="ghost" disabled={busy} onClick={onSnooze} title="Hide it until tomorrow. Gmail is not changed.">
                <Clock /> Tomorrow
              </Button>
            </>
          )}
          {mode === "done" && (
            <Button size="xs" variant="outline" disabled={busy} onClick={onUndo} title="Put it back on the list">
              <Undo2 /> Not done
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** List or one-at-a-time. */
function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div role="group" aria-label="How emails are shown" className="bg-muted flex items-center gap-0.5 rounded-lg p-0.5">
      {(["list", "deck"] as const).map((v) => (
        <button
          key={v}
          type="button"
          aria-pressed={view === v}
          onClick={() => onChange(v)}
          title={v === "deck" ? "One email at a time, with the buttons under it" : "Every email, sorted into groups"}
          className={cn(
            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px]",
            view === v ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {v === "deck" ? <Layers className="size-3.5" /> : <List className="size-3.5" />}
          {v === "deck" ? "One at a time" : "List"}
        </button>
      ))}
    </div>
  );
}

type Filter = "all" | TriageKey | "done" | "snoozed";

export function Triage() {
  const doc = useApi<TriageDoc>(() => mailflowApi.triage(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  /* Read once, at mount, so the first frame has a list on it. */
  const [last] = useState<TriageDoc | null>(() => remembered());
  const [view, setView] = useState<View>(() => rememberedView());
  const [filter, setFilter] = useState<Filter>("all");
  /**
   * WHETHER THE OUTBOX REQUIRES APPROVAL, and null means NOT YET ASKED rather
   * than "no". Everything that reads it treats null as yes, because this is the
   * setting that must fail towards a person pressing a button.
   */
  const [approval, setApproval] = useState<boolean | null>(null);
  const askedApproval = useRef(false);

  const d = doc.data ?? last;
  const running = d?.pass.running ?? false;
  const accountId = d?.account.id;

  useEffect(() => {
    if (doc.data) remember(doc.data);
  }, [doc.data]);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* A private window. The toggle still works for this session. */
    }
  }, [view]);

  /* Poll ONLY while a pass is in flight. */
  const reload = doc.reload;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => reload(), POLL_MS);
    return () => clearInterval(id);
  }, [running, reload]);

  /** The Outbox's own settings, asked for once and only when a reply is being
   *  drafted. */
  const setData = doc.setData;
  const askApproval = useCallback(() => {
    if (askedApproval.current) return;
    askedApproval.current = true;
    mailflowApi
      .outbox(null, 0, 1)
      .then((o) => setApproval(o.settings.requireApproval))
      .catch(() => {
        askedApproval.current = false;
      });
  }, []);

  /**
   * DONE AND SNOOZE, for both views. It answers with the server's sentence
   * rather than throwing, because the deck has to keep dealing after a failed
   * write and the list has to keep its row.
   */
  const act = useCallback(
    async (threadId: string, what: "done" | "snooze"): Promise<string | null> => {
      try {
        if (what === "done") await mailflowApi.done(threadId, { account: accountId });
        else await mailflowApi.snooze(threadId, { days: 1, account: accountId });
        /* The row leaves the list without a refetch, and joins Done/Snoozed. */
        setData((prev) => {
          if (!prev) return prev;
          const moved = Object.values(prev.groups).flat().find((t) => t.id === threadId);
          const groups = Object.fromEntries(
            Object.entries(prev.groups).map(([k, v]) => [k, v.filter((t) => t.id !== threadId)]),
          );
          const stamp = new Date().toISOString();
          return {
            ...prev,
            groups,
            done: what === "done" && moved ? [{ ...moved, doneAt: stamp }, ...prev.done] : prev.done,
            snoozedList:
              what === "snooze" && moved
                ? [{ ...moved, snoozed: true, snoozedUntil: new Date(Date.now() + 86_400_000).toISOString() }, ...prev.snoozedList]
                : prev.snoozedList,
          };
        });
        return null;
      } catch (err) {
        return said(err);
      }
    },
    [accountId, setData],
  );

  async function rowAct(threadId: string, what: "done" | "snooze") {
    setBusy(threadId);
    setRefused(null);
    const error = await act(threadId, what);
    if (error) setRefused(error);
    setBusy(null);
  }

  async function undoDone(threadId: string) {
    setBusy(threadId);
    setRefused(null);
    try {
      await mailflowApi.done(threadId, { account: accountId, undo: true });
      doc.reload();
    } catch (err) {
      setRefused(said(err));
    } finally {
      setBusy(null);
    }
  }

  /* The owner's own pass — the same incremental one the timer runs. */
  async function scan() {
    setScanning(true);
    setRefused(null);
    try {
      const run = await mailflowApi.runTriage({});
      if (run.error) setRefused(run.error);
      doc.reload();
    } catch (err) {
      setRefused(said(err));
    } finally {
      setScanning(false);
    }
  }

  const count = (k: TriageKey) => (d?.groups[k] ?? []).length;
  const activeTotal = GROUPS.reduce((n, g) => n + count(g.key), 0);
  const chips: FilterChip<Filter>[] = [
    { key: "all", label: "All", count: activeTotal },
    ...GROUPS.map((g) => ({
      key: g.key as Filter,
      label: g.key === "noise" ? "Newsletters" : g.label,
      count: count(g.key),
      urgent: g.key === "needs_reply",
      title: g.hint,
    })).filter((c) => c.count > 0 || c.key === "needs_reply"),
    ...(d?.done.length ? [{ key: "done" as Filter, label: "Done", count: d.done.length, title: "Emails you marked done" }] : []),
    ...(d?.snoozedList.length
      ? [{ key: "snoozed" as Filter, label: "Snoozed", count: d.snoozedList.length, title: "Hidden until tomorrow" }]
      : []),
  ];
  /* A filter whose chip vanished (its last row was cleared) falls back to All. */
  const shownFilter: Filter = chips.some((c) => c.key === filter) ? filter : "all";

  const sections: { key: string; label: string; tone: string; rows: TriageThread[]; mode: RowMode }[] = !d
    ? []
    : shownFilter === "done"
      ? [{ key: "done", label: "Done", tone: "bg-muted-foreground/40", rows: d.done, mode: "done" }]
      : shownFilter === "snoozed"
        ? [{ key: "snoozed", label: "Snoozed", tone: "bg-muted-foreground/40", rows: d.snoozedList, mode: "snoozed" }]
        : GROUPS.filter((g) => shownFilter === "all" || g.key === shownFilter).map((g) => ({
            key: g.key,
            label: g.label,
            tone: g.tone,
            rows: d.groups[g.key] ?? [],
            mode: "active" as const,
          }));

  const partial = !!d?.lastRun?.error;

  return (
    <PageShell
      title="Priority"
      sub="Your recent mail, sorted for you."
      wide
      action={
        <div className="flex w-full flex-wrap items-center gap-2">
          {d && (
            <p className="text-muted-foreground mr-auto text-[12.5px]" role="status">
              {running || scanning
                ? "Sorting new mail…"
                : d.pass.ranAt
                  ? `Sorted ${ago(d.pass.ranAt)}${until(d.pass.nextRunAt) ? ` · next ${until(d.pass.nextRunAt)}` : ""}`
                  : "Not sorted yet"}
            </p>
          )}
          <ViewToggle view={view} onChange={setView} />
          <Button size="sm" variant="outline" onClick={scan} disabled={scanning || running} title="Fetch and sort the newest mail now">
            {scanning || running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {scanning || running ? "Sorting…" : "Sort new mail"}
          </Button>
        </div>
      }
    >
      {doc.error && <Problem className="mb-4">Couldn't load your mail: {doc.error}</Problem>}
      {refused && <Problem className="mb-4">{refused}</Problem>}

      {doc.loading && !d && (
        <p className="text-muted-foreground text-[14px]">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
          Loading…
        </p>
      )}

      {d && (
        <>
          {count("unscored") > 0 && (
            <p className="text-warn mb-4 text-[13px]">
              {plural(count("unscored"), "email")} {count("unscored") === 1 ? "isn't" : "aren't"} sorted yet
              {partial ? " — sorting stopped early last time" : ""}. They're under “Not sorted yet”.
            </p>
          )}

          {view === "deck" ? (
            <Deck
              doc={d}
              accountId={accountId}
              requireApproval={approval}
              onSettings={askApproval}
              act={act}
            />
          ) : (
            <>
              <FilterChips label="Show" chips={chips} value={shownFilter} onChange={setFilter} className="mb-4" />
              {sections.map((sec) => {
                if (!sec.rows.length) return null;
                return (
                  <section key={sec.key} className="mb-5">
                    {(shownFilter === "all" || sec.mode !== "active") && (
                      <h2 className="mb-1.5 flex items-center gap-2 text-[13.5px] font-medium">
                        <span className={cn("size-2 rounded-full", sec.tone)} />
                        {sec.label}
                        <span className="text-muted-foreground font-normal">{sec.rows.length}</span>
                      </h2>
                    )}
                    <div className="bg-card border-line-soft overflow-hidden rounded-xl border">
                      {sec.rows.map((t) => (
                        <Row
                          key={t.id}
                          t={t}
                          mode={sec.mode}
                          busy={busy === t.id}
                          onDone={() => void rowAct(t.id, "done")}
                          onSnooze={() => void rowAct(t.id, "snooze")}
                          onUndo={() => void undoDone(t.id)}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}

              {!sections.some((sec) => sec.rows.length) && (
                <EmptyState
                  icon={Check}
                  title={shownFilter === "needs_reply" ? "Nothing needs a reply" : "All clear"}
                  body={
                    shownFilter === "all"
                      ? "Nothing waiting on you in the last few days. New mail is sorted every half hour."
                      : "Nothing in this group right now. Pick All to see everything."
                  }
                />
              )}
            </>
          )}

          <SmallPrint summary="How Priority works" className="mt-8">
            <p>
              Mail from the last {d.window.days} days of {d.account.label ?? "your inbox"} ({d.window.threads} emails) is
              sorted by AI into Needs reply, Waiting on them, FYI and Newsletter. Done and Tomorrow only change this
              list — nothing changes in Gmail.
            </p>
            {d.lastRun?.note && <p>Last run: {d.lastRun.note}</p>}
            {d.lastRun?.error && <p className="text-destructive">Problem: {d.lastRun.error}</p>}
            <p>{d.note}</p>
          </SmallPrint>
        </>
      )}
    </PageShell>
  );
}
