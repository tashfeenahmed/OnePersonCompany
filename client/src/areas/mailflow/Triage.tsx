import { Link } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronsRight,
  Clock,
  Loader2,
  Mail,
  Pencil,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
} from "lucide-react";
import { ago } from "@/lib/format";
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
 * TRIAGE — the inbox re-ordered by what the mail IS rather than when it came,
 * and now dealt one card at a time as well as listed.
 *
 * TWO VIEWS OF ONE SET OF ROWS, AND THE DECK IS THE DEFAULT. The list answers
 * "what is in there" and it answers it well; what it cannot do is stop the
 * failure this screen exists to prevent, which is reading everything and
 * deciding nothing. A list invites a scroll. The deck puts ONE thread on the
 * table with four verbs under it — skip it, mark it done, snooze it, or answer
 * it — and moves only when one of them is pressed. Same rows, same order, same
 * cache; the difference is that the deck cannot be scrolled past.
 *
 * THE LIST IS STILL HERE AND IS ONE PRESS AWAY. A deck is the wrong shape for
 * "how much noise came in today" and for finding one particular mail, so the
 * toggle is not a migration path — both views are permanent, and the choice is
 * remembered in this browser.
 *
 * FIVE GROUPS, AND THE FIFTH IS THE HONEST ONE. Four are the model's
 * categories; `unscored` is every thread it has not read — arrived since the
 * last pass, or a pass with no provider behind it. It is drawn LAST but it is
 * drawn, with its own count and its own sentence, because a page that quietly
 * folded those into "noise" would be hiding mail on the grounds that nobody
 * had looked at it. That is the one failure this screen is built to make
 * impossible. The deck honours the same rule: it deals unscored threads, and it
 * is NOISE it leaves out by default — with a chip that puts it back.
 *
 * EVERY CATEGORY CARRIES ITS REASON ON THE ROW. Not in a tooltip and not
 * behind a click: the category is a guess made from a subject line and 180
 * characters of snippet, and a guess shown without its argument is an oracle.
 * Where the model's venture guess was used rather than a domain match, the tag
 * says "guess" — a venture matched by host is a fact and the two must not look
 * the same.
 *
 * DONE AND SNOOZE CHANGE THIS LIST AND NOTHING IN GMAIL. That is written under
 * the header rather than left to be discovered, because every other button
 * that looks like this one — in Gmail, in every mail client — archives
 * something.
 *
 * DRAFT REPLY IS THE ONE THING ON THIS PAGE THAT READS A MESSAGE BODY, and the
 * server drops what it read with the request. Nothing it produces is queued,
 * addressed or sent by pressing it: the words land in a textarea. Sending them
 * means queueing an Outbox row and then doing exactly what the Outbox's own
 * buttons do — which, with approval on, is two presses and not one. This page
 * has no send of its own and must never grow one; see `send()` below.
 *
 * THE PAGE IS DRAWN FROM A CACHE AND SAYS HOW OLD IT IS. It used to cost a
 * Gmail round trip per thread — fifty threads, four and a half seconds of
 * spinner, on every single open — and the mail was never stored. Now a
 * background pass keeps the rows in the server's own table and this page is a
 * database read, which means it paints at once and means it can be WRONG in a
 * way the old one could not: a thread archived since the last pass is still
 * here. That trade is only acceptable if the age is on the screen, so the line
 * under the header says when it was last read and when it is read next, the
 * way Workdash's inbox does. Subject lines and snippets are now stored;
 * message bodies are still never fetched by the pass.
 *
 * IT POLLS ONLY WHILE A PASS IS RUNNING. `pass.running` comes back with every
 * document; while it is true the page re-reads every few seconds so the rows
 * fill in as the model answers, and when it goes false the polling stops. A
 * page that polled a mailbox nothing was happening to would be a timer nobody
 * asked for.
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
const VIEW_KEY = "opc.triage.view";

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
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "deck";
  } catch {
    return "deck";
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

const GROUPS: { key: string; label: string; hint: string; tone: string }[] = [
  {
    key: "needs_reply",
    label: "Needs a reply",
    hint: "Somebody is waiting on you.",
    tone: "bg-destructive",
  },
  {
    key: "waiting_on_them",
    label: "Waiting on them",
    hint: "You have answered; the ball is on the other side.",
    tone: "bg-warn",
  },
  {
    key: "fyi",
    label: "Worth knowing",
    hint: "Real, but nobody is waiting.",
    tone: "bg-ok",
  },
  { key: "noise", label: "Noise", hint: "You would never answer these.", tone: "bg-muted" },
  {
    key: "unscored",
    label: "Not scored",
    hint: "The model has not read these. That is not a verdict of noise.",
    tone: "bg-muted",
  },
];

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
              ? `Nothing but noise on this list — ${noiseHeld} thread${noiseHeld === 1 ? "" : "s"} the model would never have you answer. The chip below deals them if you want to look.`
              : "Nothing on this list to deal. Done and snoozed threads are hidden; both are still in Gmail."
            : `That is the deck — ${dealt.size} thread${dealt.size === 1 ? "" : "s"} dealt with${noiseHeld && !includeNoise ? `, and ${noiseHeld} left out as noise` : ""}.`}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {dealt.size > 0 && (
            <Button size="sm" variant="outline" onClick={() => setDealt(new Set())}>
              <RotateCcw /> Restart the deck
            </Button>
          )}
          <NoiseChip on={includeNoise} held={noiseHeld} toggle={() => setIncludeNoise((v) => !v)} />
        </div>
      </div>
    );

  const group = GROUPS.find((g) => g.key === (top.score ?? "unscored")) ?? GROUPS[4]!;
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
          <header className="border-line-soft shrink-0 border-b px-4.5 pt-3.5 pb-3">
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
              <span className="inline-flex items-center gap-1.5">
                <span className={cn("size-2 rounded-full", group.tone)} />
                {group.label}
              </span>
              {top.urgency && top.urgency !== "normal" && (
                <>
                  <span>·</span>
                  <span className={top.urgency === "high" ? "text-destructive" : ""}>
                    {top.urgency} urgency
                  </span>
                </>
              )}
              {top.ventureName && (
                <>
                  <span>·</span>
                  {/* A host match is a fact; a model match is a guess. They must
                      not look the same. */}
                  <span className="border-line-soft rounded border px-1 py-px">
                    {top.ventureName}
                    {top.ventureBy === "model" && (
                      <span className="text-muted-foreground/70"> · guess</span>
                    )}
                  </span>
                </>
              )}
              {top.unread && (
                <span className="bg-primary/70 size-1.5 rounded-full" title="Unread in Gmail" />
              )}
              <span className="ml-auto tabular-nums">{ago(top.at, { nullText: "no date" })}</span>
            </div>
            <p className="text-muted-foreground mt-2 flex min-w-0 items-baseline gap-2 text-[12.5px]">
              <span className="shrink truncate font-medium" title={top.from}>
                {top.fromName || top.from || "unknown sender"}
                {top.messages > 1 && ` (${top.messages})`}
              </span>
              <span className="min-w-0 truncate">{top.from}</span>
            </p>
            <h2 className="mt-0.5 truncate text-[17px] leading-snug tracking-[-0.02em]">
              {top.subject || "(no subject)"}
            </h2>
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
                {top.reason ? (
                  <p className="text-[13.5px] leading-relaxed italic">{top.reason}</p>
                ) : (
                  <p className="text-muted-foreground/70 text-[13.5px] leading-relaxed italic">
                    Not scored — the model has not read this thread. That is not a verdict of
                    noise.
                  </p>
                )}
                {top.stale && (
                  <p className="text-warn mt-1 text-[12.5px]">
                    Replied to since it was scored — the reason above describes a conversation
                    that has moved on.
                  </p>
                )}
                <p className="text-muted-foreground mt-2 text-[13px] leading-relaxed">
                  {top.snippet || "(no preview)"}
                </p>

                <div className="border-line-soft mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2.5">
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground -ml-1.5"
                    onClick={() => setViewThread((v) => !v)}
                  >
                    <Mail /> {viewThread ? "Hide thread" : "View thread"}
                  </Button>
                  <Link
                    className="text-muted-foreground text-[12.5px] underline"
                    to={`/mail/email?thread=${encodeURIComponent(top.id)}&account=${top.accountId}`}
                  >
                    Open in the mailbox
                  </Link>
                </div>

                {viewThread && <ThreadView key={top.id} threadId={top.id} accountId={accountId} />}

                {drafting && (
                  <p className="text-muted-foreground mt-3 animate-pulse text-[12.5px] leading-relaxed">
                    Reading the thread and drafting a reply. The bodies are read to write it and
                    dropped with the request — nothing is stored and nothing is sent.
                  </p>
                )}
                {reply.phase === "failed" && (
                  <p className="text-destructive mt-3 text-[12.5px] leading-relaxed">
                    No draft — {reply.error}
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
                    {busy ? <Loader2 className="animate-spin" /> : <Send />} Send it
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
                  <p className="text-muted-foreground text-[12.5px]">Sent. Next card…</p>
                )}
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => advance("skip")}
                  title="Decide nothing, move on. It comes back next visit. (j)"
                >
                  <ChevronsRight /> Skip
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handle("done")}
                  title="Take it off this list. Nothing changes in Gmail. (d)"
                >
                  <Check /> Done
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handle("snooze")}
                  title="Hide for a day. Nothing changes in Gmail. (s)"
                >
                  <Clock /> Snooze
                </Button>
                <Button
                  size="sm"
                  onClick={() => void draftReply()}
                  disabled={drafting}
                  title="The model drafts it from the thread. Nothing sends without you. (r)"
                >
                  {drafting ? <Loader2 className="animate-spin" /> : <Pencil />}
                  {drafting ? "Drafting…" : "Draft reply"}
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
            <RotateCcw /> Restart the deck
          </Button>
        )}
        <span className="text-muted-foreground/70 ml-auto text-[12.5px]">
          j/k or arrows skip · d done · s snooze · r draft a reply · Esc discards
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
      title="Noise is mail the model says you would never answer. It is left out of the deck unless you ask for it."
    >
      {on ? "Dealing noise too" : `Include ${held} noise`}
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
        Opening the thread from Gmail. It is read for this browser and stored nowhere.
      </p>
    );
  if (state.error)
    return (
      <p className="text-muted-foreground mt-2 text-[12.5px] leading-relaxed">
        The thread would not open — <span className="text-destructive">{state.error}</span>
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
          The last {shown.length} of {messages.length} messages.
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
              This message is HTML only. The mailbox reader draws it in its sandboxed frame.
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
            : "Approved and waiting in the Outbox. NOT SENT — approving says the words are right and sending says now, which is two presses on purpose. Dismiss puts the row back without sending it, and it still counts against the per-address floor."}
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
        Drafted by {reply.model ?? "the model"} from this thread. Nothing has been queued,
        addressed or sent — this is a textarea.{" "}
        {requireApproval === false
          ? "Approval is switched off, so Send writes the Outbox row and sends it in one press."
          : "Send writes an Outbox row and approves it; a second press sends it, exactly as the Outbox asks."}
      </p>
      <p className="text-muted-foreground mt-2.5 text-[12.5px]">
        To <span className="text-foreground">{reply.to}</span>
        {reply.inReplyTo && " · it will land in this conversation"}
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
      <p className="text-muted-foreground/70 mt-1.5 text-[12.5px] leading-relaxed">
        The Outbox appends your signature setting under this, and the preview you approve is
        what the recipient receives.
      </p>
    </div>
  );
}

/* ==================================================================== */
/*  The list                                                            */
/* ==================================================================== */

function Row({
  t,
  busy,
  onDone,
  onSnooze,
}: {
  t: TriageThread;
  busy: boolean;
  onDone: () => void;
  onSnooze: () => void;
}) {
  return (
    <div className="border-line-soft group flex items-start gap-3 border-b px-3 py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "truncate text-[14.5px]",
              t.unread ? "font-medium" : "text-foreground/90",
            )}
          >
            {t.subject || "(no subject)"}
          </span>
          {t.messages > 1 && (
            <span className="text-muted-foreground shrink-0 text-[12.5px]">
              ({t.messages})
            </span>
          )}
        </div>

        <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12.5px]">
          <span className="truncate">{t.fromName || t.from || "unknown sender"}</span>
          <Link className="underline" to={`/mail/email?thread=${encodeURIComponent(t.id)}&account=${t.accountId}`}>Open</Link>
          <Link className="underline" to="/mail/outbox" state={{ reply: { to: t.from, subject: /^re:/i.test(t.subject) ? t.subject : `Re: ${t.subject}`, account: t.accountId, thread: t.id, venture: t.venture, back: "/mail/triage" } }}>Draft reply</Link>
          <span>·</span>
          <span>{ago(t.at, { nullText: "no date" })}</span>
          {t.urgency && t.urgency !== "normal" && (
            <>
          <span>·</span>
          <span className={t.urgency === "high" ? "text-destructive" : ""}>
            {t.urgency} urgency
          </span>
            </>
          )}
          {t.ventureName && (
            <>
              <span>·</span>
              {/* A host match is a fact; a model match is a guess. They must
                  not look the same. */}
              <span className="border-line-soft rounded border px-1 py-px">
                {t.ventureName}
                {t.ventureBy === "model" && (
                  <span className="text-muted-foreground/70"> · guess</span>
                )}
              </span>
            </>
          )}
          {t.stale && (
            <>
              <span>·</span>
              <span className="text-warn">
                replied to since it was scored — the reason is out of date
              </span>
            </>
          )}
        </div>

        {t.reason ? (
          <p className="text-muted-foreground mt-1 text-[13.5px] italic">{t.reason}</p>
        ) : (
          <p className="text-muted-foreground/70 mt-1 text-[13.5px] italic">
            Not scored — the model has not read this thread.
          </p>
        )}
        <p className="text-muted-foreground/60 mt-0.5 line-clamp-1 text-[12.5px]">
          {t.snippet}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button size="xs" variant="ghost" disabled={busy} onClick={onSnooze} title="Hide for a day. Nothing changes in Gmail.">
          <Clock /> Snooze
        </Button>
        <Button size="xs" variant="outline" disabled={busy} onClick={onDone} title="Take it off this list. Nothing changes in Gmail.">
          <Check /> Done
        </Button>
      </div>
    </div>
  );
}

/** The two views, drawn as a narrowing rather than as a mode switch: no track
 *  and no fill, the chosen one lifted off the page by its surface alone. */
function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div role="group" aria-label="How the threads are shown" className="flex items-center gap-0.5">
      {(["deck", "list"] as const).map((v) => (
        <Button
          key={v}
          size="xs"
          variant={view === v ? "outline" : "ghost"}
          aria-pressed={view === v}
          className={view === v ? undefined : "text-muted-foreground"}
          onClick={() => onChange(v)}
          title={
            v === "deck"
              ? "One thread at a time, with the verbs under it"
              : "Every thread, grouped by what it is"
          }
        >
          {v === "deck" ? "Deck" : "List"}
        </Button>
      ))}
    </div>
  );
}

export function Triage() {
  const doc = useApi<TriageDoc>(() => mailflowApi.triage(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  /* Read once, at mount, so the first frame has a list on it. */
  const [last] = useState<TriageDoc | null>(() => remembered());
  const [view, setView] = useState<View>(() => rememberedView());
  /**
   * WHETHER THE OUTBOX REQUIRES APPROVAL, and null means NOT YET ASKED rather
   * than "no". Everything that reads it treats null as yes, because this is the
   * setting that must fail towards a person pressing a button — the same rule
   * the server states in `settings()`.
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

  /* Poll ONLY while a pass is in flight — see the header. `reload` is pulled
     out because it is the stable half of `doc`; depending on the object would
     restart the interval on every answer. */
  const reload = doc.reload;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => reload(), POLL_MS);
    return () => clearInterval(id);
  }, [running, reload]);

  /** The Outbox's own settings, asked for once and only when a reply is being
   *  drafted. A deck is used to triage far more often than to answer. */
  const setData = doc.setData;
  const askApproval = useCallback(() => {
    if (askedApproval.current) return;
    askedApproval.current = true;
    mailflowApi
      .outbox(null, 0, 1)
      .then((o) => setApproval(o.settings.requireApproval))
      .catch(() => {
        /* Unknown stays null, which every reader treats as "approval
           required". Allowed to be asked again on the next draft. */
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
        /* The row leaves the list without a refetch. The refetch is cheap now,
           but it is still a round trip and a repaint to redraw a list that lost
           exactly one row, and the server already knows what happened. */
        setData((prev) => {
          if (!prev) return prev;
          const groups = Object.fromEntries(
            Object.entries(prev.groups).map(([k, v]) => [k, v.filter((t) => t.id !== threadId)]),
          );
          return { ...prev, groups };
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

  /* The owner's own pass, and it is the same incremental one the timer runs:
     the window is listed, only threads that moved are read, and whatever has
     no category is scored. On a quiet inbox it is one request. */
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

  return (
    <PageShell
      title="Triage"
      sub={
        <>
          {d
            ? `${d.window.threads} threads from the last ${d.window.days} days of ${d.account.label ?? "the inbox"}, sorted by what they are. Done and Snooze change this list and nothing in Gmail.`
            : "The last few days of the inbox, sorted by what needs you."}
        </>
      }
      action={
        <div className="flex flex-wrap items-center gap-2">
          <ViewToggle view={view} onChange={setView} />
          <Button size="sm" variant="outline" onClick={scan} disabled={scanning || running}>
            {scanning || running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {scanning || running ? "Reading…" : "Run triage now"}
          </Button>
        </div>
      }
    >
      {doc.error && (
        <p className="text-muted-foreground mb-4 text-[14px]">
          The inbox could not be read.{" "}
          <span className="text-destructive">{doc.error}</span>
        </p>
      )}
      {refused && (
        <p className="text-destructive mb-4 text-[14px]">{refused}</p>
      )}

      {doc.loading && !d && (
        <p className="text-muted-foreground text-[14px]">
          <Loader2 className="mr-1.5 inline size-3.5 animate-spin" />
          Opening the list the last pass left.
        </p>
      )}

      {d && (
        <>
          {/* WHEN THIS WAS READ AND WHEN IT IS READ NEXT. The list comes out
              of a cache, so its age is part of it: a category made an hour ago
              describes an hour-old inbox, and a page that hid that would be
              passing off a stored list as a live one. */}
          <p className="text-muted-foreground mb-5 text-[12.5px]">
            {d.pass.ranAt
              ? `Read ${ago(d.pass.ranAt)}${until(d.pass.nextRunAt) ? ` · next ${until(d.pass.nextRunAt)}` : ""}`
              : "Not read yet. The pass runs by itself every half hour, or press Run triage now."}
            {running && " · reading now"}
            {d.lastRun?.note ? ` — ${d.lastRun.note}` : ""}
            {d.lastRun?.error ? ` · ${d.lastRun.error}` : ""}
            {d.pass.unscored > 0 &&
              ` · ${d.pass.unscored} thread${d.pass.unscored === 1 ? "" : "s"} in this window ${d.pass.unscored === 1 ? "has" : "have"} not been read by the model.`}
          </p>

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
              {GROUPS.map((g) => {
                const items = d.groups[g.key] ?? [];
                if (!items.length) return null;
                return (
                  <section key={g.key} className="mb-6">
                    <div className="mb-1.5 flex items-baseline gap-2">
                      <span className={cn("size-2 rounded-full", g.tone)} />
                      <h2 className="text-[15px] font-medium tracking-tight">{g.label}</h2>
                      <span className="text-muted-foreground text-[12.5px]">
                        {items.length} · {g.hint}
                      </span>
                    </div>
                    <div className="bg-card border-line-soft rounded-xl">
                      {items.map((t) => (
                        <Row
                          key={t.id}
                          t={t}
                          busy={busy === t.id}
                          onDone={() => void rowAct(t.id, "done")}
                          onSnooze={() => void rowAct(t.id, "snooze")}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}

              {!GROUPS.some((g) => (d.groups[g.key] ?? []).length) && (
                <p className="text-muted-foreground text-[14px]">
                  Nothing on this list. {d.counts.done} done and {d.counts.snoozed}{" "}
                  snoozed are hidden; both are still in Gmail.
                </p>
              )}
            </>
          )}

          <p className="text-muted-foreground/70 mt-8 text-[12.5px] leading-relaxed">
            {d.note}
          </p>
        </>
      )}
    </PageShell>
  );
}
