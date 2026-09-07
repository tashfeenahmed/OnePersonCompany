import { appPage } from "../../../shared/navigation";
import { appForKind } from "../../../shared/runRoutes";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowUp,
  ArrowUpRight,
  MessageSquare,
  Settings2,
  Square,
  TriangleAlert,
} from "lucide-react";
import { PageShell, TopBar } from "@/components/PageShell";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { Markdown } from "@/components/Markdown";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  backendPhrase,
  ordinal,
  since,
  statusTone,
} from "@/components/runs/format";
import { RoleIcon } from "@/components/org/RoleIcon";
import { runAddress, standing } from "@/components/org/roleLook";
import { useApi } from "@/hooks/useApi";
import { WORK_CHANGED } from "@/hooks/useRunQueue";
import { ago, duration } from "@/lib/format";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { readCards, runsApi } from "@/lib/api/runs";
import {
  findSubagent,
  subagentApi,
  type Exchange,
  type SubagentDetail,
} from "@/lib/api/subagents";

/**
 * ONE WORKER, DRAWN AS A CONVERSATION WITH IT.
 *
 * ---------------------------------------------------------------------------
 * THIS PAGE HAS THE CHAT'S SHAPE AND IT IS NOT A CHAT. The owner's briefs are
 * on the right, the worker's reports are on the left, and there is a composer
 * at the bottom — because that IS what happens here: a person says something
 * to a named worker and the worker answers. But the thing answering is not the
 * Chief of Staff and the page says so, in the header, in the empty state and
 * under every reply. Every message is a brief, every reply is a whole run of
 * one kind, and there is no turn-taking in between: a follow-up is a new brief
 * and a new run.
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
 * WHAT IT DRAWS IS THE RUNS LEDGER, not a message table. The server hands
 * back the worker's newest twenty runs as `transcript`, each with the brief
 * that started it and the report it produced — see subagents/routes.ts — and
 * the page polls that while anything is moving, which is what makes a report
 * appear a paragraph at a time. Nothing is stored twice: the full report,
 * its board suggestions and its files are on the run's own page, one link away.
 *
 * WHO THIS IS LIVES BEHIND A TOGGLE. Name, title, standing instructions and
 * the switch are settings about the worker, and settings do not belong in the
 * middle of a conversation with it. The gear in the header opens them above
 * the transcript; they open on their own when there is nothing to read yet.
 *
 * THE ADDRESS IS THE VENTURE AND THE ROLE, not the worker's id.
 * /ventures/<slug>/team/seo is a sentence; /subagents/sa-v-3f21-seo is a
 * primary key. See `findSubagent` for how one is turned into the other.
 */
export function Subagent() {
  const { slug, role = "" } = useParams();
  const { state } = useStore();

  /*
    THE STORE IS A SHORTCUT HERE, NOT THE SOURCE. Its venture list is a cache
    that may not have arrived, and a page that answered "no venture at this
    address" because a different fetch was slow would be reporting the wrong
    failure. Knowing the id lets `findSubagent` skip a document.
  */
  const stored = state.ventures.find((v) => v.slug === slug);
  const detail = useApi(
    () =>
      slug && role
        ? findSubagent({ role, slug, ventureId: stored?.id ?? null })
        : Promise.resolve(null),
    [slug, stored?.id, role],
  );
  const sa = detail.data;
  const reload = detail.reload;
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

  /*
    POLLED, LIKE THE RUN PAGES, and for their reason: the report is flushed to
    the row as it grows, so asking every second and a half while something is
    moving is what makes it read as streaming. Ten seconds while nothing is,
    because a run the Chief of Staff dispatches from another tab should still
    turn up here without a refresh. `reload` keeps the last document on screen
    until the next one lands, which is what stops the page blinking.
  */
  const live = !!sa && (sa.running || sa.queued > 0);
  useEffect(() => {
    const t = setInterval(reload, live ? 1500 : 10_000);
    const now = () => reload();
    window.addEventListener(WORK_CHANGED, now);
    return () => {
      clearInterval(t);
      window.removeEventListener(WORK_CHANGED, now);
    };
  }, [live, reload]);

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
  /* Open by choice, or by default when there is nothing else to look at. */
  const [settings, setSettings] = useState<boolean | null>(null);
  const settingsOpen = settings ?? (!!sa && sa.transcript.length === 0);

  /* ------------------------------------------------------------ composer */

  const [brief, setBrief] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /* ---------------------------------------------------------- the scroll */

  const scroller = useRef<HTMLElement>(null);
  /* Stuck to the bottom until the owner scrolls up to read something, and
     stuck again the moment they come back down. A report growing under a
     reader who has scrolled up must not drag them along with it. */
  const stuck = useRef(true);
  const transcript = sa?.transcript ?? [];
  const last = transcript[transcript.length - 1];
  const growth = `${transcript.length}:${last?.output.length ?? 0}:${last?.run.status ?? ""}`;
  useEffect(() => {
    const el = scroller.current;
    if (el && stuck.current) el.scrollTop = el.scrollHeight;
  }, [growth, settingsOpen]);

  /* Only once the answer is in: "there is nobody here" is a claim about the
     whole org, and until the read has finished this page does not know it. */
  if (!venture && !detail.loading)
    return (
      <>
        <TopBar label="Sub-agents" />
        <PageShell
          title="Nobody at this address"
          sub={
            detail.error
              ? `The org could not be read, so whether “${slug}” has a ${role} is not known. ${detail.error}`
              : `Nothing here is called “${slug}”, or it has no ${role}.`
          }
        >
          <Link to="/org" className="text-[13.5px] underline">
            The org chart
          </Link>
        </PageShell>
      </>
    );

  const mood = sa ? standing(sa) : null;
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
    A SEND IS A DISPATCH, and it stays on this page. The old page navigated
    to the run's report; this one is where the report is read, so the brief
    goes into the transcript on the right and the reply grows under it. The
    rail's badge is told the same way the chat tells it.
  */
  async function send() {
    if (!sa || !canSend) return;
    const text = brief.trim();
    if (!text) return;
    setSending(true);
    setProblem(null);
    try {
      await subagentApi.dispatch(sa.id, { brief: text });
      setBrief("");
      stuck.current = true;
      reload();
      window.dispatchEvent(new Event(WORK_CHANGED));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  /* Stop the run that is holding the composer. A queued one is cancelled
     outright; a running one is asked to stop and keeps what it had written. */
  async function stop() {
    const held = [...transcript].reverse().find((x) => x.run.status === "running" || x.run.status === "queued");
    if (!held) return;
    setStopping(true);
    setProblem(null);
    try {
      await runsApi.cancel(held.run.id);
      reload();
      window.dispatchEvent(new Event(WORK_CHANGED));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setStopping(false);
    }
  }

  const canSend = !!sa && sa.enabled && !live && !sending;
  const placeholder = !sa
    ? ""
    : !sa.enabled
      ? "Switched off. Turn it on in settings to give it work."
      : live
        ? `${sa.name} is on the last brief. The box opens again when the report is in.`
        : briefHint(sa.role, venture?.name ?? "this venture");

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
        {venture && (
          <>
            <span className="text-muted-foreground text-[13.5px]">/</span>
            <Link
              to={`/ventures/${venture.slug}`}
              className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 px-2 py-1 text-[13.5px]"
            >
              <VentureMark
                venture={{
                  name: venture.name,
                  color: venture.color,
                  brand: { favicon: venture.favicon },
                }}
                size={14}
              />
              {venture.name}
            </Link>
            <span className="text-muted-foreground text-[13.5px]">/</span>
            <span className="flex items-center gap-1.5 px-2 py-1 text-[13.5px]">
              <RoleIcon role={role} className="text-muted-foreground size-3.5" />
              {sa?.name ?? "…"}
            </span>
          </>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {mood && (
            <span className="text-muted-foreground mr-1.5 flex items-center gap-2 text-[12.5px]">
              <span className={cn("size-1.5 shrink-0 rounded-full", mood.tone)} />
              {mood.word}
            </span>
          )}
          {venture && <StagePill stage={venture.stage} />}
          <button
            onClick={() => setSettings(!settingsOpen)}
            title={settingsOpen ? "Hide settings" : "Who this is, and its standing instructions"}
            aria-pressed={settingsOpen}
            className={cn(
              "text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg p-2",
              settingsOpen && "bg-accent text-foreground",
            )}
          >
            <Settings2 className="size-3.5" strokeWidth={1.6} />
          </button>
          <Link
            to="/org"
            className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg px-2 py-1 text-[13.5px]"
          >
            The org
          </Link>
        </div>
      </header>

      {/* --------------------------------------------------- transcript */}
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

          {sa && venture && (
            <>
              {/*
                WHO IS ANSWERING, SAID FIRST. The page borrows the chat's
                shape, and the one thing that shape would otherwise imply is
                that the Chief of Staff is on the other end. It is not.
              */}
              <h1 className="mb-1.5 text-[27px] font-normal tracking-[-0.025em]">
                {sa.name}.{" "}
                <span className="text-muted-foreground">
                  {sa.title} for {venture.name}.
                </span>
              </h1>
              <p className="text-muted-foreground mb-6 text-[14.5px]">
                This is {sa.name}, not the chief of staff. Every message you send
                here is a brief, and every reply is one whole{" "}
                {kind?.name ?? sa.kind} run.{" "}
                {kind?.what ?? ""}
              </p>

              {settingsOpen && form && (
                <SettingsPanel
                  sa={sa}
                  ventureName={venture.name}
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
              )}

              {transcript.length === 0 ? (
                <p className="text-muted-foreground mb-6 text-[13.5px]">
                  Nothing yet. Nobody has given {sa.name} a brief and no{" "}
                  {kind?.name ?? sa.kind} run has been started from the app
                  with {venture.name} chosen. The box below is where that
                  changes.
                </p>
              ) : (
                <div className="flex flex-col gap-5 pb-2">
                  {sa.runs.length > transcript.length && (
                    <p className="text-muted-foreground text-center text-[12.5px]">
                      The last {transcript.length} of {sa.runs.length} runs.
                      The rest are on{" "}
                      <Link
                        to={appPage(appForKind(sa.kind))}
                        className="hover:text-foreground underline"
                      >
                        the {kind?.name ?? sa.kind} page
                      </Link>
                      .
                    </p>
                  )}
                  {transcript.map((x) => (
                    <ExchangeView
                      key={x.run.id}
                      x={x}
                      sa={sa}
                      busy={stopping}
                      onStop={() => void stop()}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* ----------------------------------------------------- composer */}
      <div className="flex shrink-0 justify-center px-6 pt-5 pb-5.5">
        <div className="w-full max-w-[760px]">
          <div
            className={cn(
              "bg-card rounded-[18px] border px-4 pt-3 pb-2 transition-colors",
              canSend ? "focus-within:border-foreground" : "opacity-70",
            )}
          >
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
              className="max-h-[200px] min-h-[46px] resize-none border-0 bg-transparent p-0 px-1.5 shadow-none focus-visible:ring-0 disabled:cursor-not-allowed dark:bg-transparent"
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
              {venture && sa && (
                <Link
                  to={`/?venture=${encodeURIComponent(venture.id)}&q=${encodeURIComponent(`Ask ${sa.name} to `)}`}
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
                : `${sa.name} answers with a report, not a turn. It takes minutes, queues like everything else, and carries on with this tab shut.`
              : " "}
          </p>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------- pieces */

/**
 * ONE BRIEF AND ITS REPORT. The owner's words on the right, exactly as typed —
 * plain text, not markdown, for the chat's reason: a person who types `*`
 * means an asterisk. The worker's report on the left, rendered, with the
 * board-suggestions fence taken off the end because those are filed from the
 * run's own page and a raw JSON block at the foot of a reply is noise.
 */
function ExchangeView({
  x,
  sa,
  busy,
  onStop,
}: {
  x: Exchange;
  sa: SubagentDetail;
  busy: boolean;
  onStop: () => void;
}) {
  const { run } = x;
  const body = useMemo(() => readCards(x.output).body.trim(), [x.output]);
  const inFlight = run.status === "running" || run.status === "queued";
  const took = duration(run.ms, { nullText: "" });

  /* Where the brief came from, when it was not typed on this page. */
  const origin = !x.dispatched
    ? "started from the app"
    : x.parentSessionId === "rounds"
      ? "asked by the scheduled round"
      : x.parentSessionId
        ? "asked by the chief of staff"
        : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col items-end">
        <div className="bg-card max-w-[85%] rounded-[16px] border px-4.5 py-3 text-[14.5px] whitespace-pre-wrap">
          {x.brief || (
            <span className="text-muted-foreground italic">
              No brief — the run was started with the field left empty.
            </span>
          )}
        </div>
        <p className="text-muted-foreground mt-1 text-[12.5px]">
          {ago(run.queuedAt)}
          {origin && ` · ${origin}`}
          {origin && x.parentSessionId && x.parentSessionId !== "rounds" && (
            <>
              {" "}
              <Link to={`/chat/${encodeURIComponent(x.parentSessionId)}`} className="hover:text-foreground underline">
                in this chat
              </Link>
            </>
          )}
        </p>
      </div>

      <div>
        {run.status === "queued" && (
          <p className="text-muted-foreground text-[14px]">
            {sa.name} is waiting its turn
            {x.queuePosition ? `, ${ordinal(x.queuePosition)} in the queue` : ""}. One
            run at a time on this box.
          </p>
        )}

        {run.error && (
          <p className="text-destructive mb-2 text-[13.5px] leading-relaxed">{run.error}</p>
        )}

        {body && <Markdown text={body} />}

        {run.status === "running" && (
          <p className="text-muted-foreground mt-2 text-[13.5px]">
            {sa.name} is working
            {since(run.startedAt) ? ` — ${since(run.startedAt)} so far` : ""}
            {run.steps ? ` · ${run.steps} tool call${run.steps === 1 ? "" : "s"}` : ""}…
          </p>
        )}

        {!inFlight && !body && !run.error && (
          <p className="text-muted-foreground text-[13.5px]">Nothing was written.</p>
        )}

        {/*
          SIGNED BY THE WORKER, under every reply, the way the chat signs
          every answer with its backend — and for the same reason. Which
          agent or provider actually wrote it comes after the name, because
          a report from a raw provider with no tools is not the same piece
          of work as one from a live agent.
        */}
        {!inFlight && (
          <p className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-1 text-[12.5px]">
            <span className={cn("mr-1 size-1.5 shrink-0 rounded-full", statusTone(run.status))} />
            {sa.name}
            {` · ${backendPhrase(run)}`}
            {took && ` · ${took}`}
            {x.cards > 0 && ` · ${x.cards} board suggestion${x.cards === 1 ? "" : "s"}`}
            <span>·</span>
            <Link to={runAddress(run)} className="hover:text-foreground flex items-center gap-0.5 underline">
              Full report
              <ArrowUpRight className="size-3" strokeWidth={1.8} />
            </Link>
          </p>
        )}
        {run.status === "failed" && body && (
          <p className="text-muted-foreground mt-1 text-[12.5px]">
            <TriangleAlert className="mr-1 inline size-3 align-[-1px]" strokeWidth={1.8} />
            Stopped before it finished — this is what it had written.
          </p>
        )}
        {inFlight && (
          <button
            onClick={onStop}
            disabled={busy}
            className="text-muted-foreground hover:bg-accent hover:text-foreground mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] disabled:opacity-50"
          >
            <Square className="size-3.5" strokeWidth={1.6} />
            Stop
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * WHO THIS IS: the three fields that are the owner's, and the switch.
 *
 * STANDING INSTRUCTIONS ARE PREPENDED TO EVERY BRIEF, on the server, as a
 * line that says so. They are the difference between a worker and a form:
 * "we sell to planners, not to builders" is a thing you say once.
 */
function SettingsPanel({
  sa,
  ventureName,
  form,
  dirty,
  saving,
  saved,
  onChange,
  onSave,
  onSwitch,
}: {
  sa: SubagentDetail;
  ventureName: string;
  form: { name: string; title: string; instructions: string };
  dirty: boolean;
  saving: boolean;
  saved: boolean;
  onChange: (form: { name: string; title: string; instructions: string }) => void;
  onSave: () => void;
  onSwitch: (on: boolean) => void;
}) {
  return (
    <section className="bg-card mb-6 rounded-[14px] border p-4.5">
      <div className="mb-3 flex items-center gap-2">
        <Settings2 className="text-muted-foreground size-3.5" strokeWidth={1.6} />
        <h2 className="text-[14px] font-medium">Who this is</h2>
        {/* The switch saves ITSELF, because a switch that needs a second
            press to mean anything is a checkbox pretending to be one. */}
        <label className="ml-auto flex items-center gap-2">
          <span className="text-muted-foreground text-[12.5px]">
            {sa.enabled ? "On — will accept work" : "Off — briefs are refused"}
          </span>
          <Switch checked={sa.enabled} disabled={saving} onCheckedChange={onSwitch} />
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[12.5px]">Name</span>
          <Input
            value={form.name}
            onChange={(e) => onChange({ ...form, name: e.target.value })}
            placeholder={`${ventureName} ${sa.title}`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[12.5px]">Title</span>
          <Input
            value={form.title}
            onChange={(e) => onChange({ ...form, title: e.target.value })}
          />
        </label>
      </div>

      <label className="mt-2 flex flex-col gap-1">
        <span className="text-muted-foreground text-[12.5px]">
          Standing instructions — put in front of every brief this worker is
          given. Empty means nothing has been said, which is not the same as
          told to do nothing.
        </span>
        <Textarea
          rows={4}
          value={form.instructions}
          onChange={(e) => onChange({ ...form, instructions: e.target.value })}
          placeholder="Anything this worker should always know about the venture, the audience or the house style."
        />
      </label>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button onClick={onSave} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {saved && <span className="text-muted-foreground text-[12.5px]">Saved.</span>}
      </div>
    </section>
  );
}

/** A placeholder that shows the SHAPE of a brief rather than a slogan — the
 *  thing somebody stares at an empty box wondering. Per role, because what you
 *  would say to a paper writer is not what you would say to an SEO analyst. */
function briefHint(role: string, venture: string): string {
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
    default:
      return `What should ${venture} have this worker do?`;
  }
}
