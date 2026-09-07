import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowUpRight, RefreshCw, TriangleAlert } from "lucide-react";
import { Markdown } from "@/components/Markdown";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { statusTone, statusWord } from "@/components/runs/format";
import { runAddress } from "@/components/org/roleLook";
import { PersonDialog, PersonHeader, UNFILED, WatchRail } from "@/components/org/Watchlist";
import { useApi } from "@/hooks/useApi";
import { WORK_CHANGED } from "@/hooks/useRunQueue";
import { ago, count, day, when } from "@/lib/format";
import { cn } from "@/lib/utils";
import { readCards, runsApi } from "@/lib/api/runs";
import {
  peopleApi,
  type PersonContact,
  type PersonEvent,
  type PersonFile,
  type WatchInput,
} from "@/lib/api/people";

/**
 * ONE WATCHED PERSON, AS A FILE.
 *
 * ---------------------------------------------------------------------------
 * THIS PAGE EXISTS BECAUSE A PERSON IS NOT A FILTER. Who was open used to be
 * `?person=<id>` on the analyst's own page: the same transcript, narrowed to
 * the runs whose titles named them. That was the right shape while a person
 * was nothing but a heading over some runs. They are not any more — there are
 * numbers pulled off the public internet, a timeline of what they have done,
 * the mailbox's opinion of how the correspondence is going, and a shelf of
 * every dossier ever written. None of that is a view of a conversation, so
 * none of it belongs in one, and the address says so: /team/people/<id>.
 *
 * FOUR SECTIONS, IN THE ORDER SOMEBODY ASKS THE QUESTIONS. Who are they and
 * what do I do about it (the header, with the button that writes a dossier);
 * where does this relationship stand (the mailbox); what are their numbers;
 * what have they been doing; and then, at the bottom because it is the long
 * read, everything that has been written about them.
 *
 * EVERY SECTION CAN BE EMPTY AND EACH ONE SAYS SO IN ITS OWN WORDS. "Not in
 * the mailbox" is a different fact from "nothing pulled yet", which is a
 * different fact from "no public activity on record", which is different again
 * from "no dossier yet". Four emptinesses drawn as one grey "nothing here"
 * would tell somebody their box is broken; drawn separately they tell them
 * which of four things to do next.
 *
 * NOTHING IS COMPUTED FROM A NULL. `metrics.hnKarma === null` means that site
 * had nothing to say, so no card is drawn — never a nought. `contact === null`
 * means this person's address has never appeared in the mailbox, so there is
 * no temperature, no gap and no rhythm — never "cold". `at === null` on an
 * event is an item with no date, and it keeps its place in the server's order
 * rather than being sorted to the bottom of a week it does not belong to.
 *
 * THE PULL IS A BUTTON AND NOT A SCHEDULE, on this page. It is four outbound
 * fetches to somebody else's servers, so it happens because a person asked for
 * it, it says it is happening, and it reports which of the four did not answer
 * instead of quietly showing three quarters of an answer.
 */
export function Person() {
  const { personId = "" } = useParams();
  const navigate = useNavigate();

  /* THE FILE IS ONE DOCUMENT. Four requests for one screen would be four
     polls on the same clock; the server composes it once. */
  const file = useApi(
    () => (personId ? peopleApi.personFile(personId) : Promise.resolve(null)),
    [personId],
  );
  const doc: PersonFile | null = file.data;
  const person = doc?.person ?? null;
  const setFile = file.setData;
  const reload = file.reload;

  /* The rail is the whole list, which this document deliberately does not
     carry: it is the file on ONE person, and a page that fetched eleven
     people's dossier counts to draw a sidebar would be paying for the rail on
     every poll. */
  const watch = useApi(() => peopleApi.watch(), []);
  const people = useMemo(() => watch.data?.people ?? [], [watch.data]);
  const watchReload = watch.reload;

  /* ------------------------------------------------------------- the shelf */

  /** Which dossier is being read. Null is "the newest", resolved below rather
   *  than written into state, so a run that finishes while the page is open
   *  becomes the shown one instead of the page staying on a stale pick. */
  const [picked, setPicked] = useState<string | null>(null);
  const dossiers = useMemo(() => doc?.dossiers ?? [], [doc]);
  const shown = dossiers.find((r) => r.id === picked) ?? dossiers[0] ?? null;
  const shownId = shown?.id ?? null;
  const report = useApi(
    () => (shownId ? runsApi.get(shownId) : Promise.resolve(null)),
    [shownId],
  );
  const reportReload = report.reload;
  const body = useMemo(
    () => (report.data ? readCards(report.data.output).body.trim() : ""),
    [report.data],
  );

  /* -------------------------------------------------------------- the poll */

  /* THE SAME TWO CLOCKS THE RUN PAGES KEEP. A dossier flushes its markdown as
     it is written, so a page that asked every second and a half while one is
     moving reads as streaming; ten seconds otherwise, because a run dispatched
     from another tab should still turn up here. */
  const live =
    !!person && (person.dossiers.running || person.dossiers.queued > 0);
  useEffect(() => {
    if (!personId) return;
    const beat = () => {
      reload();
      reportReload();
    };
    const t = setInterval(beat, live ? 1500 : 10_000);
    const now = () => {
      beat();
      watchReload();
    };
    window.addEventListener(WORK_CHANGED, now);
    return () => {
      clearInterval(t);
      window.removeEventListener(WORK_CHANGED, now);
    };
  }, [personId, live, reload, reportReload, watchReload]);

  /* ------------------------------------------------------------ the writes */

  const [pulling, setPulling] = useState(false);
  const [writing, setWriting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState<"this" | "new" | null>(null);
  const [saving, setSaving] = useState(false);
  const [formProblem, setFormProblem] = useState<string | null>(null);

  /** Read their public activity now. The route answers with the whole file
   *  already updated, so it is swapped in rather than polled for again. */
  const pull = useCallback(async () => {
    if (!personId) return;
    setPulling(true);
    setProblem(null);
    try {
      setFile(await peopleApi.pullPerson(personId));
      watchReload();
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setPulling(false);
    }
  }, [personId, setFile, watchReload]);

  async function writeDossier(focus: string) {
    if (!person) return;
    setWriting(true);
    setProblem(null);
    try {
      await peopleApi.dossierFor(person.id, focus || undefined);
      /* The new run is the newest, and the newest is what the shelf shows. */
      setPicked(null);
      reload();
      watchReload();
      window.dispatchEvent(new Event(WORK_CHANGED));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setWriting(false);
    }
  }

  async function savePerson(input: WatchInput) {
    setSaving(true);
    setFormProblem(null);
    try {
      if (editing === "this" && person) {
        await peopleApi.updateWatch(person.id, input);
        reload();
      } else {
        const made = await peopleApi.addWatch(input);
        navigate(`/team/people/${encodeURIComponent(made.id)}`);
      }
      setEditing(null);
      watchReload();
    } catch (e) {
      setFormProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  /** Off the list, not out of the record: the dossiers already written stay
   *  and reappear as unfiled on the analyst's page. */
  async function removePerson() {
    if (!person) return;
    setRemoving(true);
    setProblem(null);
    try {
      await peopleApi.removeWatch(person.id);
      navigate("/team/people");
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
      setRemoving(false);
    }
  }

  /* --------------------------------------------------------------- render */

  const gone = !person && !file.loading;

  return (
    <>
      <header className="flex h-12 shrink-0 items-center gap-1 px-4.5">
        <Link
          to="/subagents"
          className="text-muted-foreground hover:text-foreground px-2 py-1 text-[13.5px]"
        >
          Sub-agents
        </Link>
        <span className="text-muted-foreground text-[13.5px]">/</span>
        <Link
          to="/team/people"
          className="text-muted-foreground hover:text-foreground px-2 py-1 text-[13.5px]"
        >
          The watchlist
        </Link>
        <span className="text-muted-foreground text-[13.5px]">/</span>
        <span className="px-2 py-1 text-[13.5px]">{person?.name ?? "…"}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <Link
            to="/team/people"
            className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-lg px-2 py-1 text-[13.5px]"
          >
            The analyst
          </Link>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <WatchRail
          people={people}
          current={personId}
          /* The unfiled pile belongs to the analyst's page and is counted
             there against its runs; this page has no ledger to count, so the
             row is not drawn rather than drawn with a made-up number. */
          unfiled={0}
          loading={watch.loading && !watch.data}
          onPick={(id) =>
            navigate(
              id === null
                ? "/team/people"
                : id === UNFILED
                  ? "/team/people?person=unfiled"
                  : `/team/people/${encodeURIComponent(id)}`,
            )
          }
          onAdd={() => {
            setFormProblem(null);
            setEditing("new");
          }}
        />

        <section className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-6 pb-10">
          <div className="w-full max-w-[760px]">
            {file.error && (
              <div className="border-line-strong bg-card mb-5 rounded-[14px] border px-4.5 py-3.5 text-[13.5px]">
                <span className="font-medium">This file could not be read.</span>{" "}
                <span className="text-muted-foreground">{file.error}</span>
              </div>
            )}

            {gone && !file.error && (
              <>
                <h1 className="mb-1.5 text-[24px] font-normal tracking-[-0.02em]">
                  Nobody at this address
                </h1>
                <p className="text-muted-foreground text-[14px]">
                  There is no watched person with that id — they may have been
                  taken off the list. The dossiers written about them are kept;
                  they are on{" "}
                  <Link to="/team/people?person=unfiled" className="underline">
                    the unfiled pile
                  </Link>
                  .
                </p>
              </>
            )}

            {!person && !gone && !file.error && (
              <p className="text-muted-foreground text-[13.5px]">Opening the file…</p>
            )}

            {person && doc && (
              <>
                <PersonHeader
                  /* KEYED, so an armed "Really remove" does not survive a
                     switch to somebody else in the rail. */
                  key={person.id}
                  person={person}
                  removing={removing}
                  writing={writing}
                  onEdit={() => {
                    setFormProblem(null);
                    setEditing("this");
                  }}
                  onRemove={() => void removePerson()}
                  onWrite={(focus) => void writeDossier(focus)}
                />

                {problem && (
                  <p role="alert" className="text-destructive mb-4 text-[13px]">
                    {problem}
                  </p>
                )}

                <Relationship contact={doc.contact} />

                <Numbers person={person} events={doc.events.length} />

                <Activity
                  events={doc.events}
                  pulledAt={person.metrics.at}
                  warnings={doc.warnings}
                  pulling={pulling}
                  onPull={() => void pull()}
                />

                {/* ------------------------------------------- the shelf */}
                <h2 className="mb-2 text-[14px] font-medium">Dossiers</h2>
                {dossiers.length === 0 ? (
                  <p className="text-muted-foreground text-[13.5px]">
                    No dossier yet. The button at the top writes the first one.
                  </p>
                ) : (
                  <>
                    <div className="mb-3 flex flex-wrap items-center gap-1.5">
                      {dossiers.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => setPicked(r.id)}
                          title={`${r.title} · ${statusWord(r.status)}`}
                          className={cn(
                            "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12.5px] transition-colors",
                            r.id === shownId
                              ? "bg-primary text-primary-foreground"
                              : "bg-card hover:bg-card-hover",
                          )}
                        >
                          <span
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              statusTone(r.status),
                            )}
                          />
                          {day(r.finishedAt ?? r.queuedAt)}
                        </button>
                      ))}
                    </div>

                    {report.data ? (
                      <article>
                        {report.data.error && (
                          <p className="text-destructive mb-2 text-[13.5px] leading-relaxed">
                            {report.data.error}
                          </p>
                        )}
                        {body && <Markdown text={body} />}
                        {report.data.status === "running" && (
                          <p className="text-muted-foreground mt-2 text-[13.5px]">
                            writing…
                          </p>
                        )}
                        {report.data.status === "queued" && (
                          <p className="text-muted-foreground text-[13.5px]">
                            Waiting its turn. One run at a time on this box.
                          </p>
                        )}
                        {!body &&
                          !report.data.error &&
                          report.data.status !== "running" &&
                          report.data.status !== "queued" && (
                            <p className="text-muted-foreground text-[13.5px]">
                              Nothing was written.
                            </p>
                          )}
                        {report.data.status === "failed" && body && (
                          <p className="text-muted-foreground mt-1 text-[12.5px]">
                            <TriangleAlert
                              className="mr-1 inline size-3 align-[-1px]"
                              strokeWidth={1.8}
                            />
                            Stopped before it finished — this is what it had
                            written.
                          </p>
                        )}
                        <p className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-1 text-[12.5px]">
                          {when(report.data.finishedAt ?? report.data.queuedAt)}
                          <span>·</span>
                          <Link
                            to={runAddress(report.data)}
                            className="hover:text-foreground flex items-center gap-0.5 underline"
                          >
                            Full report
                            <ArrowUpRight className="size-3" strokeWidth={1.8} />
                          </Link>
                        </p>
                      </article>
                    ) : (
                      <p className="text-muted-foreground text-[13.5px]">
                        {report.error ?? "Reading the report…"}
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </section>
      </div>

      <PersonDialog
        open={editing !== null}
        person={editing === "this" ? person : null}
        saving={saving}
        problem={formProblem}
        onOpenChange={(open) => !open && setEditing(null)}
        onSave={(input) => void savePerson(input)}
      />
    </>
  );
}

/* ------------------------------------------------------------ the mailbox */

/**
 * WHERE THIS RELATIONSHIP STANDS, FROM THE MAIL AND ONLY FROM THE MAIL.
 *
 * NULL IS A SENTENCE, NOT A COLD BADGE. A person with no address on file, or
 * one whose address has never appeared in the connected mailbox, has no
 * measured rhythm — and drawing that as "cold" would report a relationship as
 * broken when what actually happened is that nobody has ever emailed them.
 *
 * "warm" IS DRAWN AS "current" because that is what it means here: mail is
 * passing at about its usual rate. The other two keep their own words, which
 * are already plain.
 */
function Relationship({ contact }: { contact: PersonContact | null }) {
  if (!contact)
    return (
      <p className="text-muted-foreground mb-6 text-[13.5px]">
        Not in the mailbox — no correspondence rhythm to show.
      </p>
    );

  const word =
    contact.temperature === "warm"
      ? "current"
      : contact.temperature === "cooling"
        ? "cooling"
        : contact.temperature === "cold"
          ? "cold"
          : "no rhythm measured yet";
  const look =
    contact.temperature === "warm"
      ? "ok"
      : contact.temperature === "cooling"
        ? "warn"
        : contact.temperature === "cold"
          ? "destructive"
          : "muted";

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px]">
        <Badge variant={look}>{word}</Badge>
        <span>
          {contact.quietDays === null
            ? "no gap measured yet"
            : `quiet ${contact.quietDays} ${contact.quietDays === 1 ? "day" : "days"}`}
        </span>
        {contact.cadenceDays !== null && (
          <span className="text-muted-foreground">
            · usually every {contact.cadenceDays} days
          </span>
        )}
        {contact.lastAt && (
          <span className="text-muted-foreground">
            · last exchange {day(contact.lastAt)}
          </span>
        )}
        <span className="text-muted-foreground">
          · {contact.received} in, {contact.sent} out
        </span>
      </div>
      {contact.why && (
        <p className="text-muted-foreground mt-1 text-[12.5px]">{contact.why}</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the numbers */

/**
 * THE FIVE FIGURES THE PUBLIC INTERNET WILL GIVE UP ABOUT SOMEBODY.
 *
 * A CARD IS DRAWN ONLY WHERE THERE IS A MEASUREMENT. A person with no GitHub
 * has no GitHub followers, and a card reading "0" would be this page inventing
 * a reading nobody took — the one thing every figure on this app is arranged
 * around not doing. Five nulls and no events is the state before anybody has
 * pressed Refresh, and it says exactly that instead of drawing five noughts.
 */
function Numbers({
  person,
  events,
}: {
  person: { metrics: PersonFile["person"]["metrics"] };
  /** How many public events are on record — because five nulls with a
   *  timeline under them is "these sites had nothing", and five nulls with
   *  nothing under them is "nobody has looked yet". */
  events: number;
}) {
  const m = person.metrics;
  const cards: { label: string; value: number }[] = [];
  if (m.ghFollowers !== null) cards.push({ label: "GitHub followers", value: m.ghFollowers });
  if (m.ghRepos !== null) cards.push({ label: "GitHub repos", value: m.ghRepos });
  if (m.bskyFollowers !== null)
    cards.push({ label: "Bluesky followers", value: m.bskyFollowers });
  if (m.bskyPosts !== null) cards.push({ label: "Bluesky posts", value: m.bskyPosts });
  if (m.hnKarma !== null) cards.push({ label: "HN karma", value: m.hnKarma });

  if (cards.length === 0 && events === 0)
    return (
      <p className="text-muted-foreground mb-6 text-[13.5px]">
        Nothing pulled yet — press Refresh to read their public activity.
      </p>
    );
  if (cards.length === 0) return null;

  return (
    <section className="mb-6">
      <div className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[14px] font-medium">Tracked numbers</h2>
        {m.at && (
          <span className="text-muted-foreground text-[12.5px]">
            measured {ago(m.at)}
          </span>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {cards.map((c) => (
          <div key={c.label} className="bg-card rounded-[14px] px-4 py-3.5">
            <div className="text-muted-foreground text-[12px]">{c.label}</div>
            <div className="text-[22px] tabular-nums">{count(c.value)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------- the timeline */

/** Monday of the week a stamp falls in, as a key and a label. Weeks rather
 *  than days because public activity is lumpy — four commits on a Tuesday and
 *  nothing for nine days — and a day-grouped list of that is mostly headings. */
function weekOf(iso: string | null): { key: string; label: string } {
  if (!iso) return { key: "undated", label: "No date" };
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return { key: "undated", label: "No date" };
  const monday = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return {
    key: monday.toISOString().slice(0, 10),
    label: `Week of ${day(monday)}`,
  };
}

const WEEK_MS = 7 * 86_400_000;

/** First seen inside the last week. THE STAMP THAT MATTERS IS `firstSeenAt`
 *  and not `at`: "new" means the reader has not had a chance to see it, which
 *  is a fact about this box, not about the world. */
function isNew(e: PersonEvent): boolean {
  const seen = Date.parse(e.firstSeenAt);
  return Number.isFinite(seen) && Date.now() - seen < WEEK_MS;
}

/** github, bluesky, hn, rss — as themselves. No icon set, because a source the
 *  server adds tomorrow would have no icon and would draw as a hole. */
function SourceChip({ source }: { source: string }) {
  return (
    <span className="bg-muted text-muted-foreground shrink-0 rounded-md px-1.5 py-px text-[11px]">
      {source}
    </span>
  );
}

/** How many rows before the list stops being a page and starts being a log. */
const FIRST = 60;

function Activity({
  events,
  pulledAt,
  warnings,
  pulling,
  onPull,
}: {
  events: PersonEvent[];
  pulledAt: string | null;
  warnings: string[];
  pulling: boolean;
  onPull: () => void;
}) {
  const [all, setAll] = useState(false);
  const listed = all ? events : events.slice(0, FIRST);

  /* Grouped in the server's order rather than re-sorted. Its order is the
     claim that the top row is the newest, and a second sort here would be
     this page quietly disagreeing with it. */
  const weeks: { key: string; label: string; events: PersonEvent[] }[] = [];
  for (const e of listed) {
    const w = weekOf(e.at);
    const last = weeks[weeks.length - 1];
    if (last && last.key === w.key) last.events.push(e);
    else weeks.push({ ...w, events: [e] });
  }

  return (
    <section className="mb-6">
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h2 className="text-[14px] font-medium">Activity</h2>
        <span className="text-muted-foreground text-[12.5px]">
          pulled {pulledAt ? ago(pulledAt) : "never"}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={pulling}
          onClick={onPull}
        >
          <RefreshCw className={cn("size-3.5", pulling && "animate-spin")} strokeWidth={1.8} />
          {pulling ? "Reading…" : "Refresh"}
        </Button>
      </div>

      {/* A PULL THAT READ THREE OF FOUR SOURCES IS A PARTIAL SUCCESS, and what
          is on screen is still true. The sentence says which quarter is
          missing rather than the page throwing the other three away. */}
      {warnings.length > 0 && (
        <ul className="text-muted-foreground mb-2 text-[12.5px]">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {events.length === 0 ? (
        <p className="text-muted-foreground text-[13.5px]">
          No public activity on record yet.
        </p>
      ) : (
        <>
          <div className="flex flex-col">
            {weeks.map((w) => (
              <Fragment key={w.key}>
                <div className="text-muted-foreground bg-background sticky top-0 z-10 py-1 text-[11.5px] tracking-[0.04em] uppercase">
                  {w.label}
                </div>
                {w.events.map((e) => (
                  <div
                    key={e.key}
                    className="border-line-soft flex items-baseline gap-2 border-b py-1.5 last:border-b-0"
                  >
                    <SourceChip source={e.source} />
                    {e.url ? (
                      <a
                        href={e.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="hover:text-foreground min-w-0 flex-1 truncate text-[13.5px] underline decoration-transparent transition-colors hover:decoration-current"
                      >
                        {e.title}
                      </a>
                    ) : (
                      <span className="min-w-0 flex-1 truncate text-[13.5px]">
                        {e.title}
                      </span>
                    )}
                    {isNew(e) && (
                      <span className="bg-ok-bg text-ok shrink-0 rounded-full px-1.5 text-[10px] font-medium tracking-[0.06em]">
                        NEW
                      </span>
                    )}
                    <span className="text-muted-foreground shrink-0 font-mono text-[11.5px]">
                      {e.at ? day(e.at) : "—"}
                    </span>
                  </div>
                ))}
              </Fragment>
            ))}
          </div>

          {!all && events.length > FIRST && (
            <button
              onClick={() => setAll(true)}
              className="text-muted-foreground hover:text-foreground mt-2 text-[12.5px] underline"
            >
              Show all {events.length}
            </button>
          )}
        </>
      )}
    </section>
  );
}
