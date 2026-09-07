import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Plus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { statusWord } from "@/components/runs/format";
import { PersonAvatar } from "@/components/org/PersonAvatar";
import { personAddress } from "@/components/org/roleLook";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  hrefFor,
  LINK_SITES,
  said,
  type WatchInput,
  type WatchLinks,
  type WatchPerson,
} from "@/lib/api/people";

/**
 * THE PEOPLE THE OWNER IS WATCHING, AND THE FILE ON EACH OF THEM.
 *
 * ---------------------------------------------------------------------------
 * A WATCHLIST IS A LIST OF NAMES, NOT A LIST OF RUNS, and everything about
 * this file follows from that. The Dossiers app already draws the runs — it
 * groups them by the words in their titles and calls the groups people, which
 * is the strongest claim a pile of free text can support. But it can only ever
 * show somebody the owner has ALREADY written about. A person of interest the
 * owner has not got round to is invisible there, and that is exactly the
 * person a watchlist is for: the founder they mean to look up, the customer
 * they are about to meet, the correspondent whose last three emails changed
 * tone. So the list exists on the server, independent of any run, and a
 * dossier is something that happens TO a name on it.
 *
 * A PERSON IS A PLACE NOW. Picking a name used to narrow the analyst's
 * transcript in place; it opens their file at /team/people/<id> instead —
 * numbers, public activity, correspondence and every dossier ever written.
 * That is a page rather than a filter, so it has an address, and the cards
 * here are the way in to it.
 *
 * THE GRID IS ALWAYS DRAWN, INCLUDING WHEN IT IS EMPTY, and the dotted square
 * at the end of it is both the way to add somebody and the whole zero state.
 * The form used to stand open under an explanation on an empty list, which
 * made the first thing a new owner saw a nine-box form rather than the one
 * gesture they needed. One dotted square and one sentence is the same offer
 * with none of the furniture.
 *
 * THE STATUS DOT IS THREE STATES AND NOT TWO. Amber while a dossier is being
 * written or is waiting its turn; green when there is a file to read; grey
 * when there is not. "No dossier yet" is not a failure and is never drawn as
 * red — it is the ordinary condition of somebody added five seconds ago.
 *
 * NOTHING HERE INVENTS A FIELD. A person with no company has no company: the
 * meta line drops the separator rather than printing "role · ". `said()` is
 * the one place a null becomes "", so no component below has to remember.
 */

/* ------------------------------------------------------------------ bits */

/** Where the rail's two non-person rows point. `null` is everyone; the unfiled
 *  pile is a place rather than a person, so it gets a name of its own rather
 *  than an id that could one day collide with a real one. */
export const UNFILED = "unfiled";

/** Amber while something is moving, green when there is a file, grey when
 *  there is not. Work in flight beats "has a dossier" for the reason every
 *  status on this app does: what is happening now is the more urgent fact. */
function tone(p: WatchPerson): string {
  if (p.dossiers.running) return "bg-warn animate-pulse";
  if (p.dossiers.queued > 0) return "bg-warn";
  if (p.dossiers.count > 0) return "bg-ok opacity-60";
  return "bg-border";
}

/** One line under a name: what is happening, then who they are, then the
 *  honest fallback. Never a fabricated blank. */
function meta(p: WatchPerson): string {
  const flight = p.dossiers.running
    ? "writing dossier · "
    : p.dossiers.queued > 0
      ? "queued · "
      : "";
  const who = [said(p.role), said(p.company)].filter(Boolean).join(" · ");
  return flight + (who || said(p.email) || "no dossier yet");
}

/** Role and company, or the address, or the fact that neither was typed. */
function whoLine(p: WatchPerson): string {
  return (
    [said(p.role), said(p.company)].filter(Boolean).join(" · ") ||
    said(p.email) ||
    "no role or company on file"
  );
}

/** How thick the file is, in words. A count with no date is half an answer —
 *  three dossiers, the newest from March, is a different situation to three
 *  from this morning. */
function fileLine(p: WatchPerson): string {
  const n = p.dossiers.count;
  const last = p.dossiers.last;
  /* No finished dossier, but an attempt on record: say what became of it
     rather than "no dossier yet", which reads as "nobody has tried". */
  if (n === 0 && last) {
    const at = last.finishedAt ?? last.queuedAt;
    if (last.status === "running") return "writing the first dossier…";
    if (last.status === "queued") return "first dossier queued";
    return `last attempt ${statusWord(last.status)} · ${ago(at)}`;
  }
  if (n === 0) return "no dossier yet";
  const newest = p.dossiers.last;
  const at = newest ? (newest.finishedAt ?? newest.queuedAt) : null;
  return `${n} ${n === 1 ? "dossier" : "dossiers"}${at ? ` · newest ${ago(at)}` : ""}`;
}

/** THE OWNER'S OWN WORDS, drawn as themselves. No colour per tag and no
 *  taxonomy: "investor" and "rude on the phone" are the same kind of thing
 *  here, which is a note somebody wrote. */
export function Tags({ tags, className }: { tags: string[]; className?: string }) {
  if (tags.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {tags.map((t) => (
        <span
          key={t}
          className="bg-muted text-muted-foreground rounded-full px-2 py-px text-[11.5px]"
        >
          {t}
        </span>
      ))}
    </div>
  );
}

/** The links somebody filled in, as chips that leave this app. Built through
 *  `hrefFor` so a handle, a bare domain and a pasted URL all land in the same
 *  place — see `@/lib/personLinks`. */
export function LinkChips({ links }: { links: WatchLinks }) {
  const drawn = LINK_SITES.map((site) => ({
    key: site.key,
    label: site.label,
    url: hrefFor(site.key, links?.[site.key]),
  })).filter((l) => l.url !== null);
  if (drawn.length === 0) return null;
  return (
    <>
      {drawn.map((l) => (
        <a
          key={l.key}
          href={l.url!}
          target="_blank"
          rel="noreferrer noopener"
          className="bg-card hover:bg-card-hover flex items-center gap-1 rounded-full px-2.5 py-1 text-[12.5px] transition-colors"
        >
          {l.label}
          <ArrowUpRight className="size-3" strokeWidth={1.8} />
        </a>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ rail */

/**
 * THE PEOPLE, DOWN THE SIDE, INSTEAD OF THE RUNS.
 *
 * The other workers' rail lists what the worker has done, because on those
 * pages a run is the unit somebody navigates by. Here it is not: the owner
 * thinks "what do we know about Jane", and the three dossiers on Jane are the
 * answer to that question rather than three separate things to find. So this
 * rail lists the names, and a name is a page.
 *
 * "EVERYONE" IS A ROW AND NOT AN X. It is the state the page opens in, it is
 * where the cards are, and a rail whose only way back was deselecting the
 * current row would be a rail with a mode nobody can see.
 *
 * WHITE, RATHER THAN THE SIDEBAR'S TINT, and so is the runs rail beside it.
 * Two greys stacked — the app's own rail, then the page's — read as one
 * gutter with a seam down it; the page's rail is a surface the reader works
 * on, and on paper that surface is paper.
 */
export function WatchRail({
  people,
  current,
  unfiled,
  loading,
  onPick,
  onAdd,
}: {
  people: WatchPerson[];
  /** A person's id, `UNFILED`, or null for everyone. */
  current: string | null;
  /** How many runs on this worker name nobody who is being watched. */
  unfiled: number;
  loading: boolean;
  onPick: (id: string | null) => void;
  onAdd: () => void;
}) {
  const row =
    "flex w-full items-center gap-2 rounded-[9px] px-1.5 py-1.5 text-left transition-colors";

  return (
    <aside className="border-line-soft hidden w-[264px] shrink-0 flex-col border-r bg-white lg:flex dark:bg-background">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-3 pb-3">
        <button
          onClick={() => onPick(null)}
          className={cn(row, current === null ? "bg-accent" : "hover:bg-accent")}
        >
          <Users className="text-muted-foreground size-4 shrink-0" strokeWidth={1.6} />
          <span className="min-w-0 flex-1 truncate text-[13.5px]">Everyone</span>
          <span className="text-muted-foreground shrink-0 text-[11.5px]">
            {people.length}
          </span>
        </button>

        <div className="mt-1 flex flex-col gap-px">
          {people.map((p) => (
            <button
              key={p.id}
              onClick={() => onPick(p.id)}
              className={cn(row, current === p.id ? "bg-accent" : "hover:bg-accent")}
            >
              <PersonAvatar person={p} size={22} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{p.name}</span>
                  {/* WHAT HAS TURNED UP SINCE THEY WERE LAST LOOKED AT. A
                      count rather than a dot, because "three new things" and
                      "one new thing" are different reasons to open a file. */}
                  {p.newEvents > 0 && (
                    <span className="bg-ok-bg text-ok shrink-0 rounded-full px-1.5 text-[10.5px] font-medium">
                      {p.newEvents}
                    </span>
                  )}
                  <span className={cn("size-1.5 shrink-0 rounded-full", tone(p))} />
                </span>
                <span className="text-muted-foreground block truncate text-[11.5px]">
                  {meta(p)}
                </span>
              </span>
            </button>
          ))}
        </div>

        {/* NOBODY ON THE LIST IS NOT NOBODY LOADING. Until the read is back
            this says so rather than claiming the list is empty. */}
        {people.length === 0 && (
          <p className="text-muted-foreground px-1.5 py-2 text-[12.5px]">
            {loading ? "Reading the list…" : "Nobody on the list yet."}
          </p>
        )}

        {/* THE RUNS THAT BELONG TO NOBODY, at the bottom because that is what
            they are: dossiers written before the list existed, or on people who
            have since been taken off it. They are not hidden and they are not
            filed under somebody they are not about. */}
        {unfiled > 0 && (
          <button
            onClick={() => onPick(UNFILED)}
            className={cn(
              "mt-2",
              row,
              current === UNFILED ? "bg-accent" : "hover:bg-accent",
            )}
          >
            <span className="bg-border size-1.5 shrink-0 rounded-full" />
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-[13px]">
              Unfiled
            </span>
            <span className="text-muted-foreground shrink-0 text-[11.5px]">{unfiled}</span>
          </button>
        )}
      </div>

      <div className="border-line-soft shrink-0 border-t p-2">
        <button
          onClick={onAdd}
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-2 rounded-[9px] px-1.5 py-1.5 text-left text-[13.5px] transition-colors"
        >
          <Plus className="size-4 shrink-0" strokeWidth={1.6} />
          Add person
        </button>
      </div>
    </aside>
  );
}

/* --------------------------------------------------------------- the one */

/**
 * WHO IS OPEN, at the top of their own file.
 *
 * THE PRIMARY ACTION IS ON THE HEADER because there is exactly one thing this
 * page is for: writing a dossier on this person. The focus box beside it is
 * one line and optional — empty means the standard profile, which is what the
 * server writes when nothing is said — and it is a box rather than a second
 * page because "what has changed since June?" is six words, not a form.
 *
 * TWO PRESSES TO REMOVE, because one press deletes something the owner typed.
 */
export function PersonHeader({
  person,
  onEdit,
  onRemove,
  removing,
  onWrite,
  writing,
}: {
  person: WatchPerson;
  onEdit: () => void;
  onRemove: () => void;
  removing: boolean;
  onWrite: (focus: string) => void;
  writing: boolean;
}) {
  const [sure, setSure] = useState(false);
  const [focus, setFocus] = useState("");
  useEffect(() => {
    if (!sure) return;
    const t = setTimeout(() => setSure(false), 4000);
    return () => clearTimeout(t);
  }, [sure]);

  const line = [said(person.role), said(person.company)].filter(Boolean).join(" · ");
  const flight = writing || person.dossiers.running || person.dossiers.queued > 0;

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-start gap-3">
        <PersonAvatar person={person} size={40} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-[24px] leading-tight font-normal tracking-[-0.02em]">
            {person.name}
            <span className={cn("size-1.5 shrink-0 rounded-full", tone(person))} />
          </h1>
          <p className="text-muted-foreground text-[13.5px]">
            {line || said(person.email) || "Nothing said about them yet."}
          </p>
          <Tags tags={person.tags} className="mt-2" />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant={sure ? "destructive" : "ghost"}
            size="sm"
            disabled={removing}
            onClick={() => (sure ? onRemove() : setSure(true))}
          >
            {removing ? "Removing…" : sure ? "Really remove" : "Remove"}
          </Button>
        </div>
      </div>

      {(said(person.email) || Object.keys(person.links ?? {}).length > 0) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {said(person.email) && (
            <a
              href={`mailto:${said(person.email)}`}
              className="bg-card hover:bg-card-hover rounded-full px-2.5 py-1 text-[12.5px] transition-colors"
            >
              {said(person.email)}
            </a>
          )}
          <LinkChips links={person.links ?? {}} />
        </div>
      )}

      {said(person.note) && (
        <p className="text-muted-foreground mt-3 text-[13.5px] whitespace-pre-wrap">
          {said(person.note)}
        </p>
      )}

      {/* ASK FOR ONE, FROM HERE. The focus box is beside the button rather
          than under it: it is an argument to the press, and a box on its own
          row reads as a second thing to do. */}
      <div className="mt-4 flex flex-wrap items-start gap-2">
        <Button disabled={flight} onClick={() => onWrite(focus.trim())}>
          {flight
            ? person.dossiers.queued > 0 && !person.dossiers.running
              ? "Queued…"
              : "Writing…"
            : person.dossiers.count > 0
              ? "Write another dossier"
              : "Write a dossier"}
        </Button>
        <Textarea
          rows={1}
          aria-label="What the dossier should look into"
          value={focus}
          disabled={flight}
          onChange={(e) => setFocus(e.target.value)}
          placeholder="Optional — what should it look into?"
          className="min-h-[36px] w-full max-w-[420px] flex-1 resize-none py-2 text-[13px]"
        />
      </div>

      <p className="text-muted-foreground mt-2 text-[12.5px]">{fileLine(person)}</p>
    </div>
  );
}

/* ------------------------------------------------------------- the cards */

/**
 * EVERYONE, AS CARDS, with the way to add one as the last of them.
 *
 * THE ADD TILE IS PART OF THE GRID rather than a button in a toolbar, for the
 * Ventures page's reason: the list and the way to grow it are the same
 * gesture, and on an empty grid the dotted square IS the empty state.
 *
 * TWO ACTIONS AND THEY ARE DIFFERENT VERBS. "Open" goes to the file — the
 * numbers, the activity, everything ever written. "Add to chat" brings the
 * person BACK to the composer on this page, which is the other thing an owner
 * looking at a grid of names wants: to say something about one of them without
 * leaving the eleven others. One card, two destinations, both named.
 */
export function PersonGrid({
  people,
  attached,
  onAttach,
  onAdd,
}: {
  people: WatchPerson[];
  /** Whose chip is currently in the composer, so the card can say so rather
   *  than offering to attach somebody who already is. */
  attached: string | null;
  onAttach: (person: WatchPerson) => void;
  onAdd: () => void;
}) {
  return (
    <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
      {people.map((p) => (
        <div key={p.id} className="bg-card flex min-h-[168px] flex-col rounded-[14px] p-4">
          <Link to={personAddress(p.id)} className="flex items-start gap-2.5">
            <PersonAvatar person={p} size={26} className="mt-0.5" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
                  {p.name}
                </span>
                <span className={cn("size-1.5 shrink-0 rounded-full", tone(p))} />
              </span>
              <span className="text-muted-foreground block truncate text-[12.5px]">
                {whoLine(p)}
              </span>
            </span>
          </Link>

          <Tags tags={p.tags} className="mt-2.5" />

          <p className="text-muted-foreground mt-2.5 text-[12.5px]">
            {fileLine(p)}
            {p.newEvents > 0 && ` · ${p.newEvents} new`}
          </p>

          <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
            <Button
              size="sm"
              variant="outline"
              disabled={attached === p.id}
              onClick={() => onAttach(p)}
            >
              {attached === p.id ? "In the box" : "Add to chat"}
            </Button>
            <Button size="sm" variant="ghost" asChild>
              <Link to={personAddress(p.id)}>Open</Link>
            </Button>
          </div>
        </div>
      ))}

      {/* THE DOTTED SQUARE. Square rather than card-shaped so it reads as a
          slot to fill rather than as a person with no name, and capped in
          height so that on a wide grid it does not stretch four real cards to
          the width of a column. */}
      <button
        onClick={onAdd}
        className="text-muted-foreground hover:border-line-strong hover:text-foreground border-line-strong/60 flex aspect-square max-h-[220px] min-h-[168px] flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed transition-colors"
      >
        <Plus className="size-[22px]" strokeWidth={1.5} />
        <span className="text-[14px]">Add one</span>
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- the form */

/**
 * THE ONE FORM, FOR ADDING AND FOR EDITING, IN A DIALOG.
 *
 * IT WAS A CARD AND IT IS A DIALOG NOW, and the argument that kept it inline
 * has expired. The old note said a dialog would cover the list somebody is
 * adding to, and that the thing they most want while typing a name is to see
 * whether it is already there — but the server answers that question properly
 * with a 409 on the name, and it is shown right here under the box. What the
 * inline card actually cost was the grid: a nine-field form pushing eleven
 * people down the page every time somebody fixed a typo, and, on an empty
 * list, a form as the first thing anybody ever saw.
 *
 * THE SERVER'S 409 IS SHOWN WHERE IT HAPPENED. A duplicate name is a real
 * answer — somebody is already on the list — and it belongs under the name box
 * rather than in a toast that has gone by the time the owner looks up.
 *
 * TAGS ARE COMMA-SEPARATED TEXT and not a chip editor. They are the owner's
 * own words, they are written once and read many times, and a box that turns
 * "investor, met at YC" into two tags is a thing anybody can predict.
 */
export function PersonDialog({
  open,
  person,
  saving,
  problem,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  /** The person being edited, or null for a new one. */
  person: WatchPerson | null;
  saving: boolean;
  problem: string | null;
  onOpenChange: (open: boolean) => void;
  onSave: (input: WatchInput) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] gap-3 overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {person ? `Edit ${person.name}` : "Add a person of interest"}
          </DialogTitle>
          <DialogDescription>
            Only the name is required. Everything else is what the analyst has to
            go on — the links are where it reads them in public.
          </DialogDescription>
        </DialogHeader>
        {/* KEYED ON WHO IS BEING EDITED so re-opening on somebody else starts
            from their fields rather than from the last person's. */}
        <PersonFields
          key={person?.id ?? "new"}
          person={person}
          saving={saving}
          problem={problem}
          onCancel={() => onOpenChange(false)}
          onSave={onSave}
        />
      </DialogContent>
    </Dialog>
  );
}

function PersonFields({
  person,
  saving,
  problem,
  onCancel,
  onSave,
}: {
  person: WatchPerson | null;
  saving: boolean;
  problem: string | null;
  onCancel: () => void;
  onSave: (input: WatchInput) => void;
}) {
  const [form, setForm] = useState(() => ({
    name: person?.name ?? "",
    role: said(person?.role),
    company: said(person?.company),
    email: said(person?.email),
    note: said(person?.note),
    tags: (person?.tags ?? []).join(", "),
    links: Object.fromEntries(
      LINK_SITES.map((s) => [s.key, said(person?.links?.[s.key])]),
    ) as Record<string, string>,
  }));

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const named = form.name.trim().length > 0;

  const submit = () =>
    onSave({
      name: form.name.trim(),
      role: form.role.trim(),
      company: form.company.trim(),
      email: form.email.trim(),
      note: form.note,
      /* SPLIT, TRIMMED, AND THE BLANKS DROPPED. "a, b, " is two tags. */
      tags: form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
      links: Object.fromEntries(
        LINK_SITES.map((s) => [s.key, (form.links[s.key] ?? "").trim()]),
      ) as WatchLinks,
    });

  return (
    <div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[12.5px]">
            Name — the only thing that is required
          </span>
          <Input
            autoFocus
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="Jane Doe"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[12.5px]">Role</span>
          <Input
            value={form.role}
            onChange={(e) => set({ role: e.target.value })}
            placeholder="Founder"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[12.5px]">Company</span>
          <Input
            value={form.company}
            onChange={(e) => set({ company: e.target.value })}
            placeholder="Acme"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-muted-foreground text-[12.5px]">Email</span>
          <Input
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
            placeholder="jane@acme.com"
          />
        </label>
      </div>

      <label className="mt-2 flex flex-col gap-1">
        <span className="text-muted-foreground text-[12.5px]">
          Tags — your own words, separated by commas
        </span>
        <Input
          value={form.tags}
          onChange={(e) => set({ tags: e.target.value })}
          placeholder="investor, met at the conference"
        />
      </label>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {LINK_SITES.map((site) => (
          <label key={site.key} className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[12.5px]">{site.label}</span>
            <Input
              value={form.links[site.key] ?? ""}
              onChange={(e) => set({ links: { ...form.links, [site.key]: e.target.value } })}
              placeholder={site.hint}
            />
            {/* WHERE IT WILL ACTUALLY GO, as they type. A handle box that
                silently becomes a URL should show the URL rather than making
                somebody save and click to find out. */}
            {hrefFor(site.key, form.links[site.key]) && (
              <span className="text-muted-foreground truncate text-[11.5px]">
                {hrefFor(site.key, form.links[site.key])}
              </span>
            )}
          </label>
        ))}
      </div>

      <label className="mt-2 flex flex-col gap-1">
        <span className="text-muted-foreground text-[12.5px]">
          Note — why they are on the list. It goes to the analyst with every
          dossier.
        </span>
        <Textarea
          rows={3}
          value={form.note}
          onChange={(e) => set({ note: e.target.value })}
          placeholder="Met at the conference; considering a partnership."
        />
      </label>

      {problem && (
        <p role="alert" className="text-destructive mt-2 text-[12.5px]">
          {problem}
        </p>
      )}

      <DialogFooter className="mt-4">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button disabled={!named || saving} onClick={submit}>
          {saving ? "Saving…" : person ? "Save" : "Add"}
        </Button>
      </DialogFooter>
    </div>
  );
}
