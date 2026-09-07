import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowUp,
  MessageSquare,
  RefreshCw,
  Settings2,
  Square,
  X,
} from "lucide-react";
import { PageShell, TopBar } from "@/components/PageShell";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { RoleIcon } from "@/components/org/RoleIcon";
import { PersonAvatar } from "@/components/org/PersonAvatar";
import { personAddress, shortName, standing } from "@/components/org/roleLook";
import { attaches } from "@/components/org/dossiers";
import { RunRail } from "@/components/org/RunRail";
import { RunChat } from "@/components/org/RunChat";
import {
  PersonDialog,
  PersonGrid,
  UNFILED,
  WatchlistButton,
  WatchlistDrawer,
} from "@/components/org/Watchlist";
import { useApi } from "@/hooks/useApi";
import { WORK_CHANGED } from "@/hooks/useRunQueue";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { sweepLine } from "@/lib/watchDeltas";
import { chatView, NEW_BRIEF } from "@/lib/runChat";
import { isLive, runsApi, type RunSummary } from "@/lib/api/runs";
import { peopleApi, type WatchInput, type WatchPerson } from "@/lib/api/people";
import { findSubagent, subagentApi, type SubagentDetail } from "@/lib/api/subagents";

/**
 * ONE WORKER, DRAWN AS A CONVERSATION WITH IT.
 *
 * ---------------------------------------------------------------------------
 * THIS PAGE HAS THE CHAT'S SHAPE AND IT IS NOT A CHAT. The owner's briefs are
 * on the right, the worker's replies are on the left, and there is a composer
 * at the bottom — because that IS what happens here: a person says something
 * to a named worker and the worker answers. But the thing answering is not the
 * Chief of Staff and the page says so, in the header, in the empty state and
 * under every reply. Every message is a brief, every reply is a whole run of
 * one kind, and there is no turn-taking in between: a follow-up is a new brief
 * and a new run.
 *
 * A RUN IS A CHAT, AND THERE IS ONLY ONE LAYOUT NOW. This page used to draw
 * two: a transcript of the newest twenty exchanges, each report under its
 * brief with a bare COUNT of the tool calls in its signature — and, when a row
 * in the rail was pressed, a document instead, with a stat strip, a folded
 * "how this run was made" and a Back link. So the tool calls a run was
 * visibly making existed on one of those views and not on the one that looked
 * like the conversation. The owner's words: "it does not show tool calls
 * although tool calls are being made — they appear on the run view I get to
 * from the sidebar. Consolidate: from the sidebar it should take me back to
 * the conversation." So: the middle is ONE run, drawn as the exchange it is,
 * tool calls and all — see `RunChat` — and `RunView` is deleted rather than
 * kept beside it.
 *
 * THE COMPOSER SHUTS WHILE THE WORKER IS BUSY, which is the one place this
 * page deliberately behaves unlike the chat. There is a single run slot on
 * this box and the org manifest tells the Chief of Staff never to dispatch the
 * same role for the same venture twice while one is in flight; a page that let
 * the owner do exactly that with the Enter key would be the rule with a hole
 * in it. So the box goes grey, its placeholder says why, and the send button
 * becomes the stop button for the run that is holding it — the same swap the
 * chat makes for a turn in flight.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE MIDDLE SHOWS, AND WHAT DECIDES IT. `?run=<id>` is the address of an
 * open conversation; `?run=new` is the blank page, which the back button can
 * return to; no parameter at all opens the NEWEST run, the way opening the app
 * lands on the last chat. The People Analyst is the exception and it is a
 * standing one: its landing page is the grid of watched people, because that
 * worker is addressed by PERSON and the grid IS its new-brief state. The
 * arithmetic is in `lib/runChat`'s `chatView`, where it can be tested.
 *
 * THE RAIL IS THE LIST OF CHATS. Every run, newest first, grouped by day, with
 * New brief at the top where New chat is. See `RunRail`.
 *
 * A BRIEF OPENS ITS OWN RUN. `dispatch` answers with the run it queued, so the
 * address moves to it the moment the send returns and the owner watches the
 * tool calls and the report arrive in place — rather than reading "queued"
 * somewhere and going to look for it. The watchlist's "write a dossier" is the
 * same dispatch and does the same thing.
 *
 * THE TRANSCRIPT IS AN INDEX NOW, NOT A VIEW. The server still sends the
 * newest twenty exchanges (`sa.transcript`) and this page still reads two
 * things out of it — the brief AS TYPED, and where it was typed — because
 * neither is on a run's own document: `GET /api/runs/:id` has the stored input
 * with the standing instructions in front of it, and nothing about the chat
 * that asked. Nothing is DRAWN from it. The field stays on the wire because
 * other readers may want it; this page just stopped painting twenty reports it
 * could only show one of at a time.
 *
 * POLLED, LIKE THE RUN PAGES. The open run polls its own document every second
 * and a half while it is moving (that read is the only one that carries the
 * STEPS); this page reloads the worker on the same cadence for the rail, ten
 * seconds when nothing is going, and on `WORK_CHANGED` — because a run the
 * Chief of Staff dispatches in another tab should turn up here without a
 * refresh.
 *
 * SETTINGS ARE A DRAWER NOW, AND IT STARTS SHUT — always, including on a
 * worker with nothing to read. The old rule opened it "when there is nothing
 * else to look at", which meant the first thing a new worker's page ever
 * showed was a form about its NAME rather than the box that gives it work.
 * The drawer is kept mounted and slid off the right edge so that opening it is
 * a movement rather than a repaint, and so that a screen reader is not offered
 * a form that is not there: `inert` and `aria-hidden` go on with the transform.
 *
 * THE ADDRESS IS THE VENTURE AND THE ROLE, not the worker's id.
 * /ventures/<slug>/team/seo is a sentence; /subagents/sa-v-3f21-seo is a
 * primary key. See `findSubagent` for how one is turned into the other.
 *
 * AND SOMETIMES THERE IS NO VENTURE, which is a fact about the worker rather
 * than a hole in the address. The People analyst belongs to no business: it
 * lives at /team/people, `venture` comes back null, and every venture-shaped
 * piece of this page — the breadcrumb, the stage pill, the "for <venture>"
 * after the title, the chief-of-staff link's `?venture=` — is left off rather
 * than filled with a placeholder. A page that said "for this venture" over a
 * worker that has none would be the one lie this file exists to avoid.
 *
 * ---------------------------------------------------------------------------
 * THE PEOPLE ANALYST IS THE SAME PAGE WITH A DIFFERENT FRONT DOOR.
 *
 * Every other worker is addressed by SUBJECT — a page, a rival, a keyword —
 * and its runs are a log, because the second sweep of a moving thing is a
 * second reading. This one is addressed by PERSON, and three dossiers on Jane
 * are one file rather than three jobs. So its landing page is a GRID OF THE
 * PEOPLE rather than its newest dossier: there IS something to show before any
 * run is opened, and picking somebody is how a brief starts here.
 *
 * A PERSON IS A PAGE, NOT A FILTER ON THIS ONE. `?person=<id>` used to narrow
 * the middle in place; a file with pulled metrics, a timeline and a shelf of
 * dossiers on it stopped being a view of this conversation, so it moved to
 * /team/people/<id> — see pages/Person.tsx. The rail's rows and the cards'
 * "Open" both go there.
 *
 * ONE QUERY PARAMETER SURVIVES, AND IT NARROWS THE RAIL. `?person=unfiled` is
 * the pile of dossiers naming somebody nobody is watching. It used to be a
 * filter over the transcript in the middle; the middle now holds one run, so
 * the pile is a filter over the LIST — the rail is narrowed to those runs and
 * says so under its tally. That is the simpler of the two honest options: the
 * other was to draw the same rows a second time in the middle, in the rail's
 * own style, which is one list of runs kept in two places on one screen for a
 * view that exists to say "these ones". Opening one is the same click it is
 * anywhere else on this page.
 *
 * "ADD TO CHAT" IS THE OTHER HALF OF A CARD. Opening a file is one thing to
 * want; saying something about somebody without leaving the eleven others is
 * the other, so a card can put a person in the composer as a chip. What that
 * actually does is put their name on the FIRST LINE of the brief, which is
 * what files the dossier under them — the owner does not have to know that,
 * which is why the chip says "About Jane Doe" and the placeholder asks what to
 * look into rather than who this is about.
 *
 * THE ATTACHMENT RULE IS THE SERVER'S, MIRRORED — see `components/org/dossiers`
 * for the whole argument. There is no person id on a run; the only join is the
 * name in the title, and both ends compare it the same way.
 */
export function Subagent() {
  const { slug, role = "" } = useParams();
  const { state } = useStore();
  const navigate = useNavigate();

  /*
    THE STORE IS A SHORTCUT HERE, NOT THE SOURCE. Its venture list is a cache
    that may not have arrived, and a page that answered "no venture at this
    address" because a different fetch was slow would be reporting the wrong
    failure. Knowing the id lets `findSubagent` skip a document.
  */
  const stored = slug ? state.ventures.find((v) => v.slug === slug) : undefined;
  const detail = useApi(
    () =>
      role
        ? findSubagent({ role, slug: slug ?? null, ventureId: stored?.id ?? null })
        : Promise.resolve(null),
    [slug, stored?.id, role],
  );
  const sa = detail.data;
  const reload = detail.reload;
  /*
    WHOSE WORKER THIS IS — the server's answer first, the store's cache second,
    and nobody's third. `portfolio` is the third case said out loud: the
    ADDRESS decides it before anything has loaded (no slug, no venture), and
    the worker's own flag decides it once the document is in. Deriving it from
    `!venture` alone would draw a venture worker whose fetch failed as though
    it belonged to nobody.
  */
  const portfolio = sa?.portfolio ?? !slug;
  const venture =
    sa?.venture ??
    (stored
      ? {
          id: stored.id,
          slug: stored.slug,
          name: stored.name,
          color: stored.color,
          stage: stored.stage,
          favicon: stored.brand.favicon,
        }
      : null);

  /* The kind's own sentence, from the runs area rather than restated here. */
  const kinds = useApi(() => runsApi.list({ limit: 1 }), []);
  const kind = kinds.data?.kinds.find((k) => k.kind === sa?.kind) ?? null;

  /* ----------------------------------------------------------- watchlist */

  /**
   * ONLY THE PEOPLE ANALYST HAS A WATCHLIST, and it is asked for by the
   * worker's own role rather than by the address. /team/people is where it
   * lives today; the fact that makes the watchlist the right rail is that this
   * worker reports on PEOPLE, which is what `role === "people"` says.
   */
  const watchlisted = sa?.role === "people" && sa.portfolio;
  const watch = useApi(
    () => (watchlisted ? peopleApi.watch() : Promise.resolve(null)),
    [watchlisted],
  );
  const watchReload = watch.reload;
  const people = useMemo(() => watch.data?.people ?? [], [watch.data]);

  /* THE ONE PERSON-SHAPED PARAMETER THAT IS STILL A VIEW. `?person=unfiled` is
     the pile of runs naming nobody on the list — a filter over the RAIL now
     that the middle holds one run. Any other value is an address that has
     moved, and the effect below sends it on rather than drawing an empty
     page. */
  const [params, setParams] = useSearchParams();
  const chosen = watchlisted ? params.get("person") : null;
  const onUnfiled = chosen === UNFILED;
  /** The address of the open conversation: a run id, `new` for the blank page,
   *  or nothing at all — which `chatView` reads as the newest run. */
  const openRunId = params.get("run");
  /** Open a run, or `NEW_BRIEF` for the blank page. Pushed rather than
   *  replaced: which conversation is open is a place the owner went to. */
  const openRun = useCallback(
    (id: string) => {
      const next = new URLSearchParams(params);
      next.set("run", id);
      setParams(next);
    },
    [params, setParams],
  );

  /** The rail, the cards and the crumb all mean the same three destinations. */
  const goTo = useCallback(
    (id: string | null) => {
      if (id === null) {
        const next = new URLSearchParams(params);
        next.delete("person");
        setParams(next);
        return;
      }
      if (id === UNFILED) {
        const next = new URLSearchParams(params);
        next.set("person", UNFILED);
        setParams(next);
        return;
      }
      navigate(personAddress(id));
    },
    [navigate, params, setParams],
  );

  /* A LINK ALREADY SENT STILL WORKS. `?person=<id>` was this page's address
     for one person for as long as the watchlist has existed; it is now that
     person's own page, so an old link is forwarded rather than landing on a
     grid that ignores it. */
  useEffect(() => {
    if (chosen && chosen !== UNFILED) navigate(personAddress(chosen), { replace: true });
  }, [chosen, navigate]);

  /*
    POLLED, LIKE THE RUN PAGES, and for their reason: the report is flushed to
    the row as it grows, so asking every second and a half while something is
    moving is what makes it read as streaming. Ten seconds while nothing is,
    because a run the Chief of Staff dispatches from another tab should still
    turn up here without a refresh. `reload` keeps the last document on screen
    until the next one lands, which is what stops the page blinking.
  */
  const live = !!sa && (sa.running || sa.queued > 0);
  /* Counted so the open run's own document can be told — see `RunView`'s
     `pollKey`. A state rather than a ref because the point is a re-render. */
  const [workTick, setWorkTick] = useState(0);
  useEffect(() => {
    const t = setInterval(reload, live ? 1500 : 10_000);
    const now = () => {
      reload();
      setWorkTick((n) => n + 1);
    };
    window.addEventListener(WORK_CHANGED, now);
    return () => {
      clearInterval(t);
      window.removeEventListener(WORK_CHANGED, now);
    };
  }, [live, reload]);

  /* THE WATCHLIST IS ON THE SAME CLOCK, because a card's "Writing…" and the
     report growing under it are two views of one run, and two clocks would
     have them disagree for eight and a half seconds at a time. */
  const watchLive = people.some((p) => p.dossiers.running || p.dossiers.queued > 0);
  useEffect(() => {
    if (!watchlisted) return;
    const t = setInterval(watchReload, watchLive || live ? 1500 : 10_000);
    const now = () => watchReload();
    window.addEventListener(WORK_CHANGED, now);
    return () => {
      clearInterval(t);
      window.removeEventListener(WORK_CHANGED, now);
    };
  }, [watchlisted, watchLive, live, watchReload]);

  /* ------------------------------------------------------------ settings */

  /**
   * THE IDENTITY WHILE IT IS BEING EDITED, and null until somebody types.
   * Null means "nobody has touched this", so the server's values are drawn;
   * the first keystroke takes ownership, and a successful save hands it back.
   */
  const [edit, setEdit] = useState<{
    name: string;
    title: string;
    instructions: string;
  } | null>(null);
  const form = edit ?? (sa ? { name: sa.name, title: sa.title, instructions: sa.instructions } : null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /* SHUT UNTIL IT IS ASKED FOR. No "open when there is nothing to read" rule:
     a page whose first screen is a form about the worker's NAME buries the box
     that gives the worker work. */
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (!settingsOpen) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [settingsOpen]);

  /* ----------------------------------------------------- the watch drawer */

  /**
   * THE WHOLE LIST, OVER WHATEVER IS OPEN. The grid in the middle is only
   * drawn on one of this page's three views — a run open or the unfiled pile
   * on and it is gone — so the list itself lives in a drawer that any of them
   * can reach. See `WatchlistDrawer`.
   *
   * ONE DRAWER AT A TIME, and the rule lives here because this is the only
   * place that holds both pieces of state. Two panels sliding out of the same
   * edge would stack, and the one underneath would be a page the reader can
   * see the shadow of and not reach.
   */
  const [watchOpen, setWatchOpen] = useState(false);
  const toggleWatch = () => {
    setWatchOpen((was) => !was);
    setSettingsOpen(false);
  };
  const toggleSettings = () => {
    setSettingsOpen((was) => !was);
    setWatchOpen(false);
  };

  /* ------------------------------------------------------------ composer */

  const [brief, setBrief] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* --------------------------------------------------- the person's form */

  /** Null is shut; `{ editing: null }` is adding; `{ editing: p }` is editing
   *  p. One piece of state, because the form is one form — and it is a dialog
   *  now rather than a card wedged above the grid. */
  const [editor, setEditor] = useState<{ editing: WatchPerson | null } | null>(null);
  const [personSaving, setPersonSaving] = useState(false);
  const [personProblem, setPersonProblem] = useState<string | null>(null);
  /** Which people have had a dossier asked for and not yet heard back. Not the
   *  same as the server's `running`: this covers the second in between. */
  const [asking, setAsking] = useState<Set<string>>(new Set());

  /**
   * WHO THE COMPOSER IS ABOUT, when a card has put somebody in it.
   *
   * ONE AT A TIME, and that is the contract rather than a simplification: the
   * server titles a dossier from the FIRST LINE of the brief and files it
   * against the watched person whose name that line is. Two names on one line
   * is a run that belongs to neither of them.
   */
  const [attached, setAttached] = useState<WatchPerson | null>(null);
  /* The row the chip names is the server's, not this component's copy of it —
     so a rename, or a dossier finishing, shows in the chip. And somebody taken
     off the list stops being attached rather than sending a brief about a
     person who is no longer watched. */
  const chip = attached ? (people.find((p) => p.id === attached.id) ?? null) : null;

  /* --------------------------------------------------------- what is open */

  const runs = useMemo(() => sa?.runs ?? [], [sa]);
  /* THE TRANSCRIPT IS AN INDEX, NOT A VIEW — the brief as the owner typed it
     and the conversation it was typed in, neither of which is on a run's own
     document. Nothing below draws it. */
  const transcript = sa?.transcript ?? [];

  /**
   * WHOSE RUNS ARE IN THE RAIL. Everything, or — on the analyst under
   * `?person=unfiled` — the ones naming nobody being watched. "Nobody" is only
   * sayable once the list has arrived, so before it does nothing is unfiled
   * rather than everything.
   */
  const listed = !!watch.data;
  /** The analyst's landing view is the CARDS. */
  const everyone = watchlisted && !onUnfiled;
  const unfiledRuns = useMemo(
    () =>
      /* NOTHING IS UNFILED UNTIL THE LIST HAS ARRIVED. Filtering against an
         empty watchlist would put every dossier under "naming nobody on the
         list" for the half second before the read lands, which is a statement
         about the owner's list rather than a loading state. */
      watchlisted && listed
        ? runs.filter((r) => !people.some((p) => attaches(r.title, p.name)))
        : [],
    [watchlisted, listed, runs, people],
  );
  /** Watched by nobody, and the read has come back to prove it. */
  const emptyList = everyone && listed && people.length === 0;

  /** The rail's rows: the whole ledger, or the unfiled pile when that is the
   *  view. Same rows, same click. */
  const railRuns = onUnfiled ? unfiledRuns : runs;
  /** A run, the blank page, or this worker's own list. See `lib/runChat`. */
  const view = chatView(openRunId, railRuns, watchlisted);
  /** How the open run's brief got here, when it is among the newest twenty. */
  const sent = view.run
    ? (transcript.find((x) => x.run.id === view.run) ?? null)
    : null;

  /* ---------------------------------------------------------- the scroll */

  const scroller = useRef<HTMLElement>(null);
  /* Stuck to the bottom until the owner scrolls up to read something, and
     stuck again the moment they come back down. A report growing under a
     reader who has scrolled up must not drag them along with it. */
  const stuck = useRef(true);
  /* THE OPEN RUN TELLS THE PAGE IT GREW, because the run's document lives
     inside `RunChat` and the scroller lives here. Stable, because it is a
     dependency of the effect over there that calls it. */
  const grew = useCallback(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, []);

  /* THE LEDGER AS THE SCROLL EFFECT SEES IT. A ref rather than a dependency,
     and the difference is the whole behaviour: a run FINISHING changes its
     status in this list, and an effect that depended on the status would then
     re-run and yank a reader who has scrolled up back to the top of a report
     at the moment it was finished. What is open is the only thing that should
     move the scroll. */
  const runsRef = useRef(runs);
  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  /* A FINISHED RUN OPENS AT ITS TOP AND A LIVE ONE IS FOLLOWED. Both are the
     same rule said twice: a document is read from the beginning, and a run in
     flight is watched at its foot, where the next tool call appears. A run
     this page has no status for is one just dispatched — the most live thing
     there is — so it is followed. */
  const ledgerIn = !!sa;
  useEffect(() => {
    const el = scroller.current;
    /* NOT UNTIL THE LEDGER IS IN. Before it lands nothing is known about the
       run in the address — and "no status" is the answer for a run just
       dispatched, which is followed. Deciding on an empty list would follow
       every run, including a finished report opened from the rail. */
    if (!el || !ledgerIn) return;
    const status = view.run
      ? runsRef.current.find((r) => r.id === view.run)?.status
      : null;
    const follow = !view.run || !status || isLive(status);
    stuck.current = follow;
    el.scrollTop = follow ? el.scrollHeight : 0;
  }, [view.run, ledgerIn]);

  function pick(run: RunSummary) {
    openRun(run.id);
  }

  /** New brief: nothing open, the composer focused, and an address the back
   *  button can return to. */
  function newBrief() {
    openRun(NEW_BRIEF);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  /* Only once the answer is in: "there is nobody here" is a claim about the
     whole org, and until the read has finished this page does not know it.

     WHAT COUNTS AS "NOBODY" DEPENDS ON THE ADDRESS. A venture worker is
     missing when the venture is — the slug in the bar names nothing, so
     nothing under it can exist. A portfolio worker has no venture to be
     missing, so the only evidence is the worker itself coming back null. */
  const nobody = slug ? !venture : !sa;
  if (nobody && !detail.loading)
    return (
      <>
        <TopBar label="Sub-agents" />
        <PageShell
          title="Nobody at this address"
          sub={
            detail.error
              ? slug
                ? `The org could not be read, so whether “${slug}” has a ${role} is not known. ${detail.error}`
                : `The org could not be read, so whether there is a ${role} worker is not known. ${detail.error}`
              : slug
                ? `Nothing here is called “${slug}”, or it has no ${role}.`
                : `Nobody works here under the name ${role}, for any venture or for none.`
          }
        >
          <Link to="/subagents" className="text-[13.5px] underline">
            The org chart
          </Link>
        </PageShell>
      </>
    );

  const mood = sa ? standing(sa) : null;
  /* THE WORKER'S SHORT NAME — the venture's own name taken off the front of
     the default "<Venture> <Title>", so the crumb, the rail and the heading do
     not each say "Example Video" twice on one line. A portfolio worker has no
     venture to take off. See `shortName`. */
  const workerName = sa ? (portfolio || !venture ? sa.name : shortName(sa.name, venture.name)) : null;
  const dirty =
    !!sa &&
    !!form &&
    (form.name !== sa.name ||
      form.title !== sa.title ||
      form.instructions !== sa.instructions);

  async function save(patch: {
    name?: string;
    title?: string;
    instructions?: string;
    enabled?: boolean;
  }) {
    if (!sa) return;
    setSaving(true);
    setProblem(null);
    try {
      await subagentApi.save(sa.id, patch);
      setEdit(null);
      reload();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  /*
    A SEND IS A DISPATCH, AND THE NEW RUN IS WHAT THE PAGE THEN SHOWS. The
    dispatch answers with the run it queued, so the address moves to it and the
    owner watches the tool calls and the report arrive in place — rather than
    reading "queued" somewhere and going to look for it. The rail's badge is
    told the same way the chat tells it.

    WITH A PERSON IN THE CHIP, THE NAME GOES ON THE FIRST LINE, and that is
    what files the dossier under them rather than in the unfiled pile. The
    server titles a dossier from the brief's first line; the typed text is the
    focus, on its own paragraph underneath. The owner does not have to know
    that — the placeholder asks what the dossier should look INTO, not who it
    is about, because the who is in the chip above the box.
  */
  async function send() {
    if (!sa || !canSend) return;
    const text = brief.trim();
    if (!text) return;
    setSending(true);
    setProblem(null);
    try {
      const { run } = await subagentApi.dispatch(sa.id, {
        brief: chip ? `${chip.name}\n\n${text}` : text,
      });
      setBrief("");
      openRun(run.id);
      reload();
      if (watchlisted) watchReload();
      window.dispatchEvent(new Event(WORK_CHANGED));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  /** The standard profile, asked for by the server so the title is exactly
   *  what the attachment rule expects. Nothing is typed and nothing needs to
   *  be: "write a dossier on this person" is the whole brief. It is the same
   *  dispatch as a send and it opens the same way — the grid gives way to the
   *  dossier being written. */
  async function writeDossier(p: WatchPerson, focus?: string) {
    setAsking((was) => new Set(was).add(p.id));
    setProblem(null);
    try {
      const { run } = await peopleApi.dossierFor(p.id, focus);
      openRun(run.id);
      reload();
      watchReload();
      window.dispatchEvent(new Event(WORK_CHANGED));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setAsking((was) => {
        const next = new Set(was);
        next.delete(p.id);
        return next;
      });
    }
  }

  /** THE GRID IS WHERE A SAVE LANDS, deliberately. Adding somebody here does
   *  not jump to their file: this is the page for building the list, and
   *  three people in a row is the ordinary way it gets built. Their card is
   *  in the grid when the dialog shuts, and "Open" is right on it. */
  async function savePerson(input: WatchInput) {
    if (!editor) return;
    setPersonSaving(true);
    setPersonProblem(null);
    try {
      const target = editor.editing;
      if (target) await peopleApi.updateWatch(target.id, input);
      else await peopleApi.addWatch(input);
      setEditor(null);
      watchReload();
    } catch (e) {
      setPersonProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setPersonSaving(false);
    }
  }

  /* Stop the run that is holding the composer. A queued one is cancelled
     outright; a running one is asked to stop and keeps what it had written.
     The ledger is newest first, so the first live row IS the one in flight. */
  async function stop(id?: string) {
    const held = id ?? runs.find((r) => isLive(r.status))?.id;
    if (!held) return;
    setStopping(true);
    setProblem(null);
    try {
      await runsApi.cancel(held);
      reload();
      if (watchlisted) watchReload();
      window.dispatchEvent(new Event(WORK_CHANGED));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setStopping(false);
    }
  }

  const canSend = !!sa && sa.enabled && !live && !sending;
  /** THE EMPTY BOX IS AN OFFER, not a dead button. With somebody in the chip
   *  and nothing typed, the one thing to do is the standard profile — so the
   *  send arrow becomes the sentence that says so. */
  const offerDossier = !!chip && !brief.trim();
  const placeholder = !sa
    ? ""
    : !sa.enabled
      ? "Switched off. Turn it on in settings to give it work."
      : live
        ? `${sa.name} is on the last brief. The box opens again when the report is in.`
        : briefHint(sa.role, venture?.name ?? "this venture", chip?.name ?? null);

  const openForm = () => {
    setPersonProblem(null);
    setEditor({ editing: null });
  };

  /** A card puts somebody in the composer. The box is focused as well as
   *  filled, because the next thing to do is type into it. */
  const attach = (p: WatchPerson) => {
    setAttached(p);
    inputRef.current?.focus();
  };

  return (
    <>
      {/* ------------------------------------------------------- header */}
      <header className="flex h-12 shrink-0 items-center gap-1 px-4.5">
        <Link
          to="/subagents"
          className="text-muted-foreground hover:text-foreground px-2 py-1 text-[13.5px]"
        >
          Sub-agents
        </Link>
        {(venture || portfolio) && (
          <>
            <span className="text-muted-foreground text-[13.5px]">/</span>
            {/* THE MIDDLE CRUMB IS WHO THIS WORKER ANSWERS TO, and for the
                People analyst that is nobody — so it is a phrase rather than
                a link. There is no page for "across every venture" to lead
                to; the org chart's card of that name is where it is drawn,
                and the crumb before this one already goes there. */}
            {portfolio ? (
              <span className="text-muted-foreground px-2 py-1 text-[13.5px]">
                Across every venture
              </span>
            ) : (
              <Link
                to={`/ventures/${venture!.slug}`}
                className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 px-2 py-1 text-[13.5px]"
              >
                <VentureMark
                  venture={{
                    name: venture!.name,
                    color: venture!.color,
                    brand: { favicon: venture!.favicon },
                  }}
                  size={14}
                />
                {venture!.name}
              </Link>
            )}
            <span className="text-muted-foreground text-[13.5px]">/</span>
            <span className="flex items-center gap-1.5 px-2 py-1 text-[13.5px]">
              <RoleIcon role={role} className="text-muted-foreground size-3.5" />
              {workerName ?? "…"}
            </span>
            {/* WHICH VIEW IS OPEN, IN THE BAR, because the transcript below
                is narrowed and a filter nobody can see is a page that looks
                broken. A crumb rather than a chip: pressing it is how you get
                back to everyone. */}
            {onUnfiled && (
              <>
                <span className="text-muted-foreground text-[13.5px]">/</span>
                <button
                  onClick={() => goTo(null)}
                  title="Back to everyone"
                  className="text-muted-foreground hover:text-foreground px-2 py-1 text-[13.5px]"
                >
                  Unfiled
                </button>
              </>
            )}
          </>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {mood && (
            <span className="text-muted-foreground mr-1.5 flex items-center gap-2 text-[12.5px]">
              <span className={cn("size-1.5 shrink-0 rounded-full", mood.tone)} />
              {mood.word}
            </span>
          )}
          {/* A stage is a venture's, and a worker with no venture has none.
              Nothing stands in for it. */}
          {!portfolio && venture && <StagePill stage={venture.stage} />}
          {/* THE WAY INTO THE LIST, LEFT OF THE GEAR. On the analyst it is the
              most-wanted thing in this corner, and it was previously reachable
              only from the middle of the page — and only on the one view that
              draws the cards. */}
          {watchlisted && (
            <WatchlistButton
              open={watchOpen}
              total={people.length}
              onClick={toggleWatch}
            />
          )}
          <button
            onClick={toggleSettings}
            title={settingsOpen ? "Hide settings" : "Who this is, and its standing instructions"}
            aria-pressed={settingsOpen}
            aria-expanded={settingsOpen}
            className={cn(
              "text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg p-2",
              settingsOpen && "bg-accent text-foreground",
            )}
          >
            <Settings2 className="size-3.5" strokeWidth={1.6} />
          </button>
          <Link
            to="/subagents"
            className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg px-2 py-1 text-[13.5px]"
          >
            The org
          </Link>
        </div>
      </header>

      {/*
        THE FRAME. `relative` because the settings drawer is positioned inside
        it rather than over the whole window — it belongs to this page, not to
        the app — and `overflow-hidden` because a panel parked at
        `translate-x-full` is 340px of content sitting off the right edge, and
        without this the page would scroll sideways to reach it.
      */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* --------------------------------------------------- the rail */}
        {/* THE RAIL IS RUNS ON EVERY WORKER, THE PEOPLE ANALYST INCLUDED — the
            list of conversations with this worker, with New brief at the top
            where New chat is. Its people are the cards in the middle; the
            rail's job is to reach a previous run — or the one working now — in
            one press, and for a dossier the brief's first line IS the person's
            name. */}
        {sa &&
          (venture || portfolio) &&
          (
            <RunRail
              name={workerName ?? sa.name}
              runs={railRuns}
              note={
                onUnfiled
                  ? `unfiled only — naming nobody on the list`
                  : null
              }
              /* The brief's first line names the run better than a title that
                 is only "<Kind> — <venture>" — the rail would otherwise read
                 the venture's name on every row. */
              label={(run) => {
                const brief = transcript.find((x) => x.run.id === run.id)?.brief.trim();
                const first = brief?.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
                return first ? (first.length > 64 ? `${first.slice(0, 63).trimEnd()}…` : first) : null;
              }}
              /* The RESOLVED run, not the raw parameter: with no `?run` at all
                 the newest is what is open, and the rail has to mark the row
                 the reader is looking at. */
              activeId={view.run}
              onPick={pick}
              onNew={newBrief}
            />
          )}

        {/* ------------------------------------------------ the middle */}
        <div className="flex min-w-0 flex-1 flex-col">
          <section
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            }}
            className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-6"
          >
            <div className="w-full max-w-[760px]">
              {detail.error && (
                <div className="border-line-strong bg-card mb-5 rounded-[14px] border px-4.5 py-3.5 text-[13.5px]">
                  <span className="font-medium">This worker could not be read.</span>{" "}
                  <span className="text-muted-foreground">{detail.error}</span>
                </div>
              )}
              {!sa && !detail.error && (
                <p className="text-muted-foreground text-[13.5px]">
                  {detail.loading ? "Looking them up…" : "Nothing came back."}
                </p>
              )}

              {sa && (venture || portfolio) && view.run ? (
                <RunChat
                  key={view.run}
                  runId={view.run}
                  worker={{ name: workerName ?? sa.name, title: sa.title }}
                  ventureName={venture?.name ?? null}
                  sent={sent}
                  onStop={(id) => void stop(id)}
                  stopping={stopping}
                  pollKey={workTick}
                  onGrew={grew}
                />
              ) : sa && (venture || portfolio) && (
                <>
                  {onUnfiled ? (
                    <>
                      <h1 className="mb-1.5 text-[20px] font-normal tracking-[-0.02em]">
                        Unfiled dossiers
                      </h1>
                      <p className="text-muted-foreground mb-6 text-[14px]">
                        {unfiledRuns.length === 0
                          ? "Every dossier on this box names somebody on the watchlist. Nothing is unfiled."
                          : `${unfiledRuns.length} ${unfiledRuns.length === 1 ? "run names" : "runs name"} somebody who is not on the watchlist — written before the list existed, or about somebody since taken off it. Adding that person puts their file back together.`}
                      </p>
                      {unfiledRuns.length > 0 && (
                        <p className="text-muted-foreground mb-6 text-[13.5px]">
                          The rail is narrowed to them — open one to read it.
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      {/*
                        WHO IS ANSWERING, SAID FIRST. The page borrows the
                        chat's shape, and the one thing that shape would
                        otherwise imply is that the Chief of Staff is on the
                        other end. It is not.
                      */}
                      {/*
                        THE VENTURE IS A LABEL ABOVE THE NAME, NOT A CLAUSE
                        AFTER IT. The heading used to read "Example Video
                        Competitor Analyst. Competitor Analyst for Example Video."
                        — the default name is "<Venture> <Title>", so the same
                        four words came round twice in one line. Now the venture
                        sits above as a mark and a name, the way its own pages
                        carry it, and the heading is the worker's SHORT name:
                        the title when the owner has not renamed it, their own
                        words when they have — with the title after, muted, only
                        when it adds something.
                      */}
                      {!portfolio && venture && (
                        <Link
                          to={`/ventures/${venture.slug}`}
                          className="bg-card hover:bg-card-hover mb-3 inline-flex items-center gap-1.5 rounded-full py-1 pr-3 pl-1.5 text-[12.5px] font-medium transition-colors"
                        >
                          <VentureMark
                            venture={{
                              name: venture.name,
                              color: venture.color,
                              brand: { favicon: venture.favicon },
                            }}
                            size={16}
                          />
                          {venture.name}
                        </Link>
                      )}
                      <h1 className="mb-1.5 text-[27px] font-normal tracking-[-0.025em]">
                        {portfolio ? (
                          <>
                            {sa.name}.{" "}
                            <span className="text-muted-foreground">
                              {sa.title}, for no venture in particular.
                            </span>
                          </>
                        ) : (
                          <>
                            {workerName}.
                            {workerName!.toLowerCase() !== sa.title.trim().toLowerCase() && (
                              <span className="text-muted-foreground"> {sa.title}.</span>
                            )}
                          </>
                        )}
                      </h1>
                      <p
                        className={cn(
                          "text-muted-foreground text-[14.5px]",
                          watchlisted ? "mb-1.5" : "mb-6",
                        )}
                      >
                        {watchlisted ? (
                          <>
                            This is {sa.name}, not the chief of staff. It belongs
                            to no venture. Everyone below is somebody you are
                            watching, and every dossier is one whole{" "}
                            {kind?.name ?? sa.kind} run. {kind?.what ?? ""}
                          </>
                        ) : portfolio ? (
                          <>
                            This is {sa.name}, not the chief of staff. It belongs
                            to no venture. Every message you send here is a brief
                            naming a person, and every reply is one whole{" "}
                            {kind?.name ?? sa.kind} run. {kind?.what ?? ""}
                          </>
                        ) : (
                          <>
                            This is {sa.name}, not the chief of staff. Every
                            message you send here is a brief, and every reply is
                            one whole {kind?.name ?? sa.kind} run.{" "}
                            {kind?.what ?? ""}
                          </>
                        )}
                      </p>
                      {/* THAT THE PULLS ARE HAPPENING FOR EVERYBODY, said
                          before the grid rather than discovered one card at a
                          time. `sweepLine` will not say "for everyone" while
                          one row has never been read — see lib/watchDeltas. */}
                      {watchlisted && watch.data && (
                        <p className="text-muted-foreground mb-6 flex items-center gap-1.5 text-[12.5px]">
                          <RefreshCw className="size-3 shrink-0" strokeWidth={1.7} />
                          {sweepLine(watch.data.sweep)}
                        </p>
                      )}
                    </>
                  )}

                  {/* ----------------------------- the watchlist's own view */}
                  {/* THE GRID IS ALWAYS DRAWN, EMPTY OR NOT, because the
                      dotted square at the end of it IS the way to add
                      somebody — so an empty list is one square and one
                      sentence rather than a card explaining that a form is
                      about to appear. */}
                  {everyone && (
                    <div className="mb-6">
                      {emptyList && (
                        <p className="text-muted-foreground mb-3 text-[13.5px]">
                          Nobody is on the list yet. Add a person of interest and
                          the People Analyst writes a sourced dossier on them.
                        </p>
                      )}
                      <PersonGrid
                        people={people}
                        attached={chip?.id ?? null}
                        onAttach={attach}
                        onAdd={openForm}
                      />
                    </div>
                  )}

                  {/* ------------------------------------- nothing open */}
                  {/* THE BLANK PAGE: a worker nobody has briefed, or New brief
                      pressed on one with a history. Two different emptinesses
                      and they get two different sentences — "nothing yet" over
                      a worker with sixty runs in the rail beside it would read
                      as data loss. */}
                  {view.blank && (
                    <NothingYet
                      sa={sa}
                      kindName={kind?.name ?? sa.kind}
                      portfolio={portfolio}
                      ventureName={venture?.name ?? null}
                      runs={runs.length}
                    />
                  )}
                </>
              )}
            </div>
          </section>

          {/* ------------------------------------------------- composer */}
          <div className="flex shrink-0 justify-center px-6 pt-5 pb-5.5">
            <div className="w-full max-w-[760px]">
              <div
                className={cn(
                  "bg-card rounded-[18px] px-4 pt-3 pb-2 transition-colors",
                  /* No opacity on the box itself: the disabled textarea already
                     fades, and two stacked opacity layers paint a visible seam
                     across the lower row. */
                  canSend && "hover:bg-card-hover focus-within:bg-card-hover",
                )}
              >
                {/* WHO THIS BRIEF IS ABOUT, above the box rather than typed
                    into it. The chip is the name that will go on the first
                    line; removing it is an × because that is what a chip's ×
                    means everywhere else on this app. */}
                {chip && (
                  <div className="mb-2 flex items-center gap-1.5 px-1.5">
                    <span className="bg-muted flex items-center gap-1 rounded-full py-1 pr-1 pl-1.5 text-[12.5px]">
                      <PersonAvatar person={chip} size={18} className="bg-card" />
                      About {chip.name}
                      <button
                        onClick={() => setAttached(null)}
                        aria-label={`Take ${chip.name} out of the brief`}
                        className="hover:bg-accent text-muted-foreground hover:text-foreground rounded-full p-0.5"
                      >
                        <X className="size-3" strokeWidth={2} />
                      </button>
                    </span>
                    <Link
                      to={personAddress(chip.id)}
                      className="text-muted-foreground hover:text-foreground text-[12.5px] underline"
                    >
                      their file
                    </Link>
                  </div>
                )}
                <Textarea
                  ref={inputRef}
                  aria-label="Brief"
                  value={brief}
                  disabled={!canSend}
                  onChange={(e) => setBrief(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={placeholder}
                  className="max-h-[200px] min-h-[46px] resize-none border-0 bg-transparent p-0 px-1.5 shadow-none hover:bg-transparent focus-visible:ring-0 disabled:cursor-not-allowed dark:bg-transparent"
                />
                {problem && (
                  <p role="alert" className="text-destructive p-1 text-xs">
                    {problem}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-0.5 pt-1">
                  {/* THE OTHER WAY TO ASK, and it is not a lesser one. The chief
                      of staff can dispatch this same worker mid-conversation and
                      file the run under the chat that asked for it. */}
                  {sa && (venture || portfolio) && (
                    <Link
                      /* `?venture=` scopes the chat to the business this worker
                         belongs to. A portfolio worker belongs to none, so the
                         parameter is left OFF rather than sent empty — an empty
                         one would read as "no venture chosen" on a page that
                         otherwise falls back to the workspace default. */
                      to={
                        portfolio
                          ? `/?q=${encodeURIComponent(`Ask ${sa.name} to `)}`
                          : `/?venture=${encodeURIComponent(venture!.id)}&q=${encodeURIComponent(`Ask ${sa.name} to `)}`
                      }
                      className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13.5px]"
                    >
                      <MessageSquare className="size-[15px]" strokeWidth={1.6} />
                      Ask the chief of staff instead
                    </Link>
                  )}
                  {/*
                    SEND BECOMES STOP, IN THE SAME PLACE — the chat's own swap.
                    While a run holds the composer the only thing to do with it
                    is stop it, and stopping keeps whatever it had written.
                  */}
                  {live ? (
                    <button
                      onClick={() => void stop()}
                      disabled={stopping}
                      title="Stop the run in flight"
                      className="bg-primary text-primary-foreground ml-auto grid size-7 place-items-center rounded-lg disabled:opacity-50"
                    >
                      <Square className="size-3 fill-current" strokeWidth={2} />
                    </button>
                  ) : offerDossier ? (
                    <Button
                      size="sm"
                      className="ml-auto"
                      disabled={!canSend || asking.has(chip!.id)}
                      onClick={() => void writeDossier(chip!)}
                    >
                      {asking.has(chip!.id) ? "Asking…" : "Write a dossier"}
                    </Button>
                  ) : (
                    <button
                      onClick={() => void send()}
                      disabled={!canSend || !brief.trim()}
                      title="Send the brief"
                      className={cn(
                        "bg-primary text-primary-foreground ml-auto grid size-7 place-items-center rounded-lg transition-opacity",
                        canSend && brief.trim() ? "opacity-100" : "pointer-events-none opacity-25",
                      )}
                    >
                      <ArrowUp className="size-4" strokeWidth={2} />
                    </button>
                  )}
                </div>
              </div>
              <p className="text-muted-foreground mt-2.5 text-center text-[12.5px]">
                {sa
                  ? live
                    ? `${sa.name} is busy. One run at a time on this box, and a second brief for the same worker would only queue behind it.`
                    : chip
                      ? `Filed under ${chip.name}: the name goes on the first line of the brief, which is what puts the dossier in their file.`
                      : `${sa.name} answers with a report, not a turn. It takes minutes, queues like everything else, and carries on with this tab shut.`
                  : " "}
              </p>
            </div>
          </div>
        </div>

        {/* THE FORM, WHEREVER IT WAS OPENED FROM — the rail's footer, the
            dotted square, or a card's Edit. A dialog rather than a card wedged
            into the grid: see components/org/Watchlist. */}
        {watchlisted && (
          <PersonDialog
            open={!!editor}
            person={editor?.editing ?? null}
            saving={personSaving}
            problem={personProblem}
            onOpenChange={(open) => !open && setEditor(null)}
            onSave={(input) => void savePerson(input)}
          />
        )}

        {/* ------------------------------------------- watchlist drawer */}
        {/* DRAWN ON EVERY VIEW OF THIS PAGE, which is the point of it: with a
            run open or the unfiled pile on there are no cards in the middle,
            and the list has to be reachable anyway. */}
        {watchlisted && (
          <WatchlistDrawer
            open={watchOpen}
            people={people}
            sweep={watch.data?.sweep ?? null}
            loading={watch.loading && !watch.data}
            unfiled={unfiledRuns.length}
            attached={chip?.id ?? null}
            onClose={() => setWatchOpen(false)}
            onAttach={(p) => {
              attach(p);
              setWatchOpen(false);
            }}
            onAdd={() => {
              setWatchOpen(false);
              openForm();
            }}
          />
        )}

        {/* -------------------------------------------- settings drawer */}
        <aside
          aria-hidden={!settingsOpen}
          inert={!settingsOpen || undefined}
          aria-label="Worker settings"
          className={cn(
            "bg-sidebar border-line-soft absolute inset-y-0 right-0 z-20 flex w-[340px] max-w-full flex-col border-l shadow-lg transition-transform duration-300 ease-out",
            settingsOpen ? "translate-x-0" : "translate-x-full",
          )}
        >
          <div className="border-line-soft flex shrink-0 items-center gap-2 border-b px-4 py-3">
            <Settings2 className="text-muted-foreground size-3.5" strokeWidth={1.6} />
            <h2 className="text-[14px] font-medium">Who this is</h2>
            <button
              onClick={() => setSettingsOpen(false)}
              aria-label="Close settings"
              className="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto rounded-lg p-1.5"
            >
              <X className="size-3.5" strokeWidth={1.6} />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {sa && form ? (
              <SettingsPanel
                sa={sa}
                /* WHAT THE NAME BOX WOULD SAY IF IT WERE EMPTY — the
                   server's own default name. A venture's worker is
                   "<Venture> SEO Analyst"; a portfolio worker is its title
                   and nothing else, because there is no venture to put in
                   front of it. */
                namePlaceholder={
                  portfolio ? sa.title : `${venture?.name ?? ""} ${sa.title}`.trim()
                }
                /* Same reason: "always know about the venture" is an
                   instruction to a worker that has one. */
                instructionsPlaceholder={
                  portfolio
                    ? "Anything this worker should always know about who you watch, what counts as a signal, or the house style."
                    : "Anything this worker should always know about the venture, the audience or the house style."
                }
                form={form}
                dirty={dirty}
                saving={saving}
                saved={saved}
                onChange={setEdit}
                onSave={() =>
                  void save({
                    name: form.name.trim(),
                    title: form.title.trim(),
                    instructions: form.instructions,
                  })
                }
                onSwitch={(on) => void save({ enabled: on })}
              />
            ) : (
              <p className="text-muted-foreground text-[13.5px]">
                Nothing to configure until the worker has been read.
              </p>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}

/* ------------------------------------------------------------- pieces */

/**
 * NOTHING OPEN, AND THE REASON WHY.
 *
 * TWO EMPTINESSES, TWO SENTENCES. A worker nobody has ever briefed is a page
 * with nothing behind it; New brief on a worker with sixty runs in the rail is
 * a blank sheet in front of a full drawer. Drawn with the same words, the
 * second reads as data loss.
 *
 * AND THE FIRST ONE SAYS WHY IT IS EMPTY IN THE WORKER'S OWN TERMS. A venture
 * worker's runs are the runs of its kind STARTED WITH THAT VENTURE CHOSEN, so
 * "nothing yet" has to name the venture or it is a claim about the whole box.
 */
function NothingYet({
  sa,
  kindName,
  portfolio,
  ventureName,
  runs,
}: {
  sa: SubagentDetail;
  kindName: string;
  portfolio: boolean;
  ventureName: string | null;
  /** How many runs are in the rail. Zero is a worker that has never worked. */
  runs: number;
}) {
  if (runs > 0)
    return (
      <p className="text-muted-foreground mb-6 text-[13.5px]">
        A new brief starts a new {kindName} run, and the reply is that whole
        run — the tool calls as they happen, then the report. The{" "}
        {runs === 1 ? "one before it is" : `${runs} before it are`} in the rail.
      </p>
    );

  return (
    <p className="text-muted-foreground mb-6 text-[13.5px]">
      {portfolio ? (
        <>
          Nothing yet. Nobody has given {sa.name} a brief and no {kindName} run
          has been started from the app. The box below is where that changes.
        </>
      ) : (
        <>
          Nothing yet. Nobody has given {sa.name} a brief and no {kindName} run
          has been started from the app with {ventureName} chosen. The box below
          is where that changes.
        </>
      )}
    </p>
  );
}

/**
 * WHO THIS IS: the three fields that are the owner's, and the switch.
 *
 * STANDING INSTRUCTIONS ARE PREPENDED TO EVERY BRIEF, on the server, as a
 * line that says so. They are the difference between a worker and a form:
 * "we sell to planners, not to builders" is a thing you say once.
 *
 * ONE COLUMN, because it lives in a 340px drawer now. The name and title used
 * to sit side by side across a 760px card; at this width that is two boxes
 * eleven characters wide.
 */
function SettingsPanel({
  sa,
  namePlaceholder,
  instructionsPlaceholder,
  form,
  dirty,
  saving,
  saved,
  onChange,
  onSave,
  onSwitch,
}: {
  sa: SubagentDetail;
  /** What the name box says while it is empty — the server's own default
   *  name for this worker. A string rather than a venture, because one of
   *  these workers has no venture. */
  namePlaceholder: string;
  /** And what the standing-instructions box says while it is empty. A worker
   *  with no venture cannot be told anything about one. */
  instructionsPlaceholder: string;
  form: { name: string; title: string; instructions: string };
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  onChange: (form: { name: string; title: string; instructions: string }) => void;
  onSave: () => void;
  onSwitch: (on: boolean) => void;
}) {
  return (
    <div>
      {/* The switch saves ITSELF, because a switch that needs a second
          press to mean anything is a checkbox pretending to be one. */}
      <label className="bg-card mb-4 flex items-center gap-2 rounded-[14px] px-3.5 py-3">
        <span className="text-muted-foreground text-[12.5px]">
          {sa.enabled ? "On — will accept work" : "Off — briefs are refused"}
        </span>
        <Switch
          className="ml-auto"
          checked={sa.enabled}
          disabled={saving}
          onCheckedChange={onSwitch}
        />
      </label>

      <label className="mb-2 flex flex-col gap-1">
        <span className="text-muted-foreground text-[12.5px]">Name</span>
        <Input
          value={form.name}
          onChange={(e) => onChange({ ...form, name: e.target.value })}
          placeholder={namePlaceholder}
        />
      </label>
      <label className="mb-2 flex flex-col gap-1">
        <span className="text-muted-foreground text-[12.5px]">Title</span>
        <Input
          value={form.title}
          onChange={(e) => onChange({ ...form, title: e.target.value })}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground text-[12.5px]">
          Standing instructions — put in front of every brief this worker is
          given. Empty means nothing has been said, which is not the same as
          told to do nothing.
        </span>
        <Textarea
          rows={7}
          value={form.instructions}
          onChange={(e) => onChange({ ...form, instructions: e.target.value })}
          placeholder={instructionsPlaceholder}
        />
      </label>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button onClick={onSave} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {saved && <span className="text-muted-foreground text-[12.5px]">Saved.</span>}
      </div>
    </div>
  );
}

/** A placeholder that shows the SHAPE of a brief rather than a slogan — the
 *  thing somebody stares at an empty box wondering. Per role, because what you
 *  would say to a paper writer is not what you would say to an SEO analyst. */
function briefHint(role: string, venture: string, person: string | null): string {
  switch (role) {
    case "researcher":
      return `What should ${venture}'s researcher look into? e.g. "Who is actually buying this, and what do they search for first?"`;
    case "competitors":
      return `e.g. "Sweep the three closest rivals and tell me where we are cheaper."`;
    case "seo":
      return `e.g. "Go through the top twenty pages and find the ones losing clicks."`;
    case "demand":
      return `e.g. "Where are people asking for this, and in whose words?"`;
    case "visibility":
      return `e.g. "Ask the models what they say about ${venture} and who they name instead."`;
    case "writer":
      return `The subject of the literature search, in three to ten words — e.g. "AI coding agents with persistent project memory".`;
    /* The one role whose brief is a PERSON rather than a subject, and the
       hint says so in the first three words — the venture is not mentioned
       because this worker has none.

       UNLESS SOMEBODY IS ALREADY OPEN, in which case the who is answered and
       the only question left is the what. Asking "who is it?" over a page
       with Jane Doe's name at the top of it would be the box ignoring the
       page it is on. */
    case "people":
      return person
        ? `What should the dossier look into? Leave it empty to write the standard profile.`
        : `Who is it? e.g. "Jane Doe, founder of Acme — what is she building now, and has anything changed since we last spoke?"`;
    default:
      return `What should ${venture} have this worker do?`;
  }
}
