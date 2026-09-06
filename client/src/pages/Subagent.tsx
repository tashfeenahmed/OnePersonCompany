import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { MessageSquare, Send } from "lucide-react";
import { PageShell, TopBar } from "@/components/PageShell";
import { StagePill, VentureMark } from "@/components/VentureChrome";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { backendPhrase, statusTone, statusWord } from "@/components/runs/format";
import { RoleIcon } from "@/components/org/RoleIcon";
import { runAddress, standing } from "@/components/org/roleLook";
import { useApi } from "@/hooks/useApi";
import { ago, duration } from "@/lib/format";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { isLive, runsApi } from "@/lib/api/runs";
import { findSubagent, subagentApi } from "@/lib/api/subagents";

/**
 * ONE WORKER: who it is, what it has been told, what it has done, and the box
 * that gives it something to do.
 *
 * ---------------------------------------------------------------------------
 * THE ADDRESS IS THE VENTURE AND THE ROLE, not the worker's id.
 * /ventures/<slug>/team/seo is a sentence; /subagents/sa-v-3f21-seo is a
 * primary key. The pairing is also the thing that is guaranteed — every
 * venture is provisioned with all six on every read of the org — where an id
 * is the server's to change. See `byVentureRole` for how one is turned into
 * the other, and for the fallback when the key format is not what this build
 * believes.
 *
 * DISPATCH IS NOT A RUN BUTTON WITH BETTER MANNERS. The six apps ask for the
 * kind's own fields; this asks for a brief in English and lets the server fill
 * the fields in, with the standing instructions prepended. That is the whole
 * difference between operating a tool and telling somebody what you want, and
 * it is why the brief box is the biggest thing on the page.
 *
 * WHAT IT PRODUCES IS AN ORDINARY RUN, which is the point rather than a
 * limitation: it queues behind everything else, it is readable at
 * /apps/<app>/<runId> like every other report, and it survives this tab. So
 * pressing Dispatch NAVIGATES to the report rather than showing a spinner
 * here — the run's own page already draws a run being written, and a second
 * screen that did it worse would be the one that goes stale.
 */
export function Subagent() {
  const { slug, role = "" } = useParams();
  const { state } = useStore();
  const navigate = useNavigate();

  /*
    THE STORE IS A SHORTCUT HERE, NOT THE SOURCE. Its venture list is a cache
    that may not have arrived — or may never arrive, on a browser that has
    only ever opened this address — and a page that answered "no venture at
    this address" because a different fetch was slow would be reporting the
    wrong failure. Knowing the id lets `findSubagent` skip a document; not
    knowing it costs one extra read and nothing else.
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
  /* The worker's own copy of its venture, which is the one that is certainly
     current — it came back with the worker. The store's is the fallback for
     the moment before the fetch lands. */
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

  /*
    THE KIND'S OWN SENTENCE, from the runs area rather than restated here. The
    org document carries it on `roles`, but that document is a hundred and
    fourteen workers deep and this page wants one line out of it; the runs list
    describes every kind in a fraction of the size. Either way the words are
    the server's — this page has never been the place that decides what an SEO
    run is for.
  */
  const kinds = useApi(() => runsApi.list({ limit: 1 }), []);
  const kind = kinds.data?.kinds.find((k) => k.kind === sa?.kind) ?? null;

  /**
   * THE IDENTITY WHILE IT IS BEING EDITED, and null until somebody types.
   *
   * DERIVED RATHER THAN SEEDED BY AN EFFECT. An effect that copied the server's
   * three fields into state when the worker landed would be a second render
   * for every load and a race with every reload — and it would overwrite a
   * half-typed name the moment a refresh came back. Null means "nobody has
   * touched this", so the server's values are what is drawn; the first
   * keystroke takes ownership, and a successful save hands it back by setting
   * this to null again.
   */
  const [edit, setEdit] = useState<{
    name: string;
    title: string;
    instructions: string;
  } | null>(null);
  const form =
    edit ??
    (sa
      ? { name: sa.name, title: sa.title, instructions: sa.instructions }
      : null);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [brief, setBrief] = useState("");
  const [sending, setSending] = useState(false);

  /* Only once the answer is in: "there is nobody here" is a claim about the
     whole org, and until the read has finished this page does not know it. */
  if (!venture && !detail.loading)
    return (
      <>
        <TopBar label="Ventures" />
        <PageShell
          title="Nobody at this address"
          sub={
            detail.error
              ? `The org could not be read, so whether “${slug}” has a ${role} is not known. ${detail.error}`
              : `Nothing here is called “${slug}”, or it has no ${role}.`
          }
        >
          <Link to="/ventures/org" className="text-[12.5px] underline">
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
      /* The server's copy is the truth again the moment it has taken the
         edit, so the local one is dropped rather than kept in step. */
      setEdit(null);
      detail.reload();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function dispatch() {
    if (!sa) return;
    setSending(true);
    setProblem(null);
    try {
      const { run } = await subagentApi.dispatch(sa.id, {
        brief: brief.trim(),
      });
      setBrief("");
      navigate(runAddress(run));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <TopBar label="Ventures" />
      <PageShell
        title={sa?.name ?? "…"}
        sub={
          sa && venture ? (
            <>
              {sa.title} for{" "}
              <Link to={`/ventures/${venture.slug}`} className="hover:underline">
                {venture.name}
              </Link>
              . {kind?.what ?? "Runs this venture's work of one kind."}
            </>
          ) : (
            "One of a venture's six."
          )
        }
        action={
          <div className="flex items-center gap-2">
            {venture && (
              <>
                <VentureMark
                  venture={{
                    name: venture.name,
                    color: venture.color,
                    brand: { favicon: venture.favicon },
                  }}
                  size={16}
                />
                <StagePill stage={venture.stage} />
              </>
            )}
            <Link
              to="/ventures/org"
              className="text-muted-foreground hover:text-foreground text-[12.5px]"
            >
              The org
            </Link>
          </div>
        }
      >
        {detail.error && (
          <p className="text-muted-foreground text-[13px]">
            This worker could not be read.{" "}
            <span className="text-destructive">{detail.error}</span>
          </p>
        )}
        {!sa && !detail.error && (
          <p className="text-muted-foreground text-[12.5px]">
            {detail.loading ? "Looking them up…" : "Nothing came back."}
          </p>
        )}

        {venture && sa && form && (
          <div className="flex flex-col gap-6">
            {/* --------------------------------------------------- identity */}
            <section>
              <div className="mb-2 flex items-center gap-2">
                <RoleIcon role={role} className="text-muted-foreground size-3.5" />
                <h2 className="text-[13px] font-medium">Who this is</h2>
                <div className="ml-auto flex items-center gap-2">
                  {mood && (
                    <>
                      <span
                        className={cn(
                          "size-1.5 shrink-0 rounded-full",
                          mood.tone,
                        )}
                      />
                      <span className="text-muted-foreground text-[11.5px]">
                        {mood.word}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-[11.5px]">
                    Name
                  </span>
                  <Input
                    value={form.name}
                    onChange={(e) =>
                      setEdit({ ...form, name: e.target.value })
                    }
                    placeholder={`${venture.name} ${sa.title}`}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-muted-foreground text-[11.5px]">
                    Title
                  </span>
                  <Input
                    value={form.title}
                    onChange={(e) =>
                      setEdit({ ...form, title: e.target.value })
                    }
                  />
                </label>
              </div>

              {/*
                STANDING INSTRUCTIONS ARE PREPENDED TO EVERY BRIEF, on the
                server, as a line that says so. They are the difference between
                a worker and a form: "we sell to planners, not to builders" is
                a thing you say once, and it should not have to be re-typed
                into a text box every time somebody wants a report.
              */}
              <label className="mt-2 flex flex-col gap-1">
                <span className="text-muted-foreground text-[11.5px]">
                  Standing instructions — prepended to every brief this worker
                  is given. Empty means nothing has been said, which is not the
                  same as told to do nothing.
                </span>
                <Textarea
                  rows={4}
                  value={form.instructions}
                  onChange={(e) =>
                    setEdit({ ...form, instructions: e.target.value })
                  }
                  placeholder="Anything this worker should always know about the venture, the audience or the house style."
                />
              </label>

              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Button
                  onClick={() =>
                    save({
                      name: form.name.trim(),
                      title: form.title.trim(),
                      instructions: form.instructions,
                    })
                  }
                  disabled={!dirty || saving}
                >
                  {saving ? "Saving…" : "Save"}
                </Button>
                {saved && (
                  <span className="text-muted-foreground text-[11.5px]">
                    Saved.
                  </span>
                )}

                {/* The switch saves ITSELF, because a switch that needs a
                    second press to mean anything is a checkbox pretending to
                    be a switch. */}
                <label className="ml-auto flex items-center gap-2">
                  <span className="text-muted-foreground text-[11.5px]">
                    {sa.enabled
                      ? "On — will accept work"
                      : "Off — dispatch is refused"}
                  </span>
                  <Switch
                    checked={sa.enabled}
                    disabled={saving}
                    onCheckedChange={(on) => void save({ enabled: on })}
                  />
                </label>
              </div>
            </section>

            {/* --------------------------------------------------- dispatch */}
            <section>
              <div className="mb-2 flex items-center gap-2">
                <Send
                  className="text-muted-foreground size-3.5"
                  strokeWidth={1.6}
                />
                <h2 className="text-[13px] font-medium">Give it a brief</h2>
              </div>
              <p className="text-muted-foreground mb-2 text-[11.5px]">
                Written in English, not in fields — the server turns it into
                this kind's inputs and puts your standing instructions above
                it. It queues like everything else and carries on with this tab
                shut.
              </p>
              <Textarea
                rows={4}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                disabled={!sa.enabled}
                placeholder={briefHint(sa.role, venture.name)}
              />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <Button
                  onClick={() => void dispatch()}
                  disabled={!brief.trim() || sending || !sa.enabled}
                >
                  {sending ? "Dispatching…" : "Dispatch"}
                </Button>
                {sa.running && (
                  <span className="text-muted-foreground text-[11.5px]">
                    This one is already working. A second brief queues behind
                    the first.
                  </span>
                )}
                {!sa.enabled && (
                  <span className="text-muted-foreground text-[11.5px]">
                    Switched off. Turn it back on above to dispatch.
                  </span>
                )}

                {/* THE OTHER WAY TO ASK, and it is not a lesser one. The chief
                    of staff can dispatch this same worker mid-conversation and
                    file the run under the chat that asked for it, which is the
                    thing this page cannot do: a brief typed here belongs to
                    nobody's conversation. */}
                <Link
                  to={`/?venture=${encodeURIComponent(venture.id)}&q=${encodeURIComponent(`Ask ${sa.name} to `)}`}
                  className="text-muted-foreground hover:text-foreground ml-auto flex items-center gap-1.5 text-[11.5px]"
                >
                  <MessageSquare className="size-3.5" strokeWidth={1.6} />
                  Ask the chief of staff instead
                </Link>
              </div>
              {problem && (
                <p className="text-destructive mt-2 text-[12px]">{problem}</p>
              )}
            </section>

            {/* ---------------------------------------------------- history */}
            <section>
              <div className="mb-2 flex items-baseline gap-2">
                <h2 className="text-[13px] font-medium">What it has done</h2>
                <span className="text-muted-foreground ml-auto text-[11.5px]">
                  {sa.counts.done} kept · {sa.counts.failed} failed
                </span>
              </div>
              <p className="text-muted-foreground mb-2 text-[11.5px]">
                Every {sa.kind} run filed under {venture.name}, dispatched by
                name or started from the app — a run of this kind against this
                venture IS this worker's work, whoever pressed the button.
              </p>
              {sa.runs.length ? (
                <div className="flex flex-col gap-px">
                  {sa.runs.map((r) => {
                    const took = duration(r.ms, { nullText: "" });
                    return (
                      <Link
                        key={r.id}
                        to={runAddress(r)}
                        className="hover:bg-accent -mx-1.5 flex items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors"
                      >
                        <span
                          className={cn(
                            "size-1.5 shrink-0 rounded-full",
                            statusTone(r.status),
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-[12.5px]">
                          {r.title}
                        </span>
                        <span className="text-muted-foreground hidden w-[168px] shrink-0 truncate text-right text-[11.5px] lg:block">
                          {backendPhrase(r)}
                        </span>
                        <span className="text-muted-foreground w-[132px] shrink-0 text-right text-[11.5px]">
                          {isLive(r.status)
                            ? statusWord(r.status)
                            : `${took ? `${took} · ` : ""}${ago(r.finishedAt ?? r.queuedAt)}`}
                        </span>
                      </Link>
                    );
                  })}
                </div>
              ) : (
                <p className="text-muted-foreground text-[12.5px]">
                  Nothing yet. Nobody has asked this one for anything and no
                  {" "}
                  {sa.kind} run has been started from an app with {venture.name}
                  {" "}
                  chosen.
                </p>
              )}
            </section>
          </div>
        )}
      </PageShell>
    </>
  );
}

/** A placeholder that shows the SHAPE of a brief rather than a slogan — the
 *  thing somebody stares at an empty box wondering. Per role, because what you
 *  would say to a paper writer is not what you would say to an SEO analyst. */
function briefHint(role: string, venture: string): string {
  switch (role) {
    case "researcher":
      return `What should I look into about ${venture}? e.g. "Who is actually buying this, and what do they search for first?"`;
    case "competitors":
      return `e.g. "Sweep the three closest rivals and tell me where we are cheaper."`;
    case "seo":
      return `e.g. "Go through the top twenty pages and find the ones losing clicks."`;
    case "demand":
      return `e.g. "Where are people asking for this, and in whose words?"`;
    case "visibility":
      return `e.g. "Ask the models what they say about ${venture} and who they name instead."`;
    case "writer":
      return `e.g. "Write the paper on our pricing experiment, for a technical reader."`;
    default:
      return `What should ${venture} have this worker do?`;
  }
}
