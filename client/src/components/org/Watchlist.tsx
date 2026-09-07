import { useEffect, useState } from "react";
import { ArrowUpRight, Plus, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { statusWord } from "@/components/runs/format";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { said, type WatchInput, type WatchLinks, type WatchPerson } from "@/lib/api/people";

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
 * WHICH IS WHY THE ZERO STATE IS A GRID AND NOT AN EMPTY TRANSCRIPT. On every
 * other worker's page "nothing yet" is a fair thing to draw, because a worker
 * with no runs has done nothing. Here there is something to show before any
 * run exists — the people — and a page that showed an empty conversation over
 * a list of eleven watched humans would be reporting the wrong emptiness.
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

/** The initial-letter tile. A picture would be better and this app has none of
 *  anybody — a generated avatar would be a face nobody has, so it is a letter. */
function Tile({ name, className }: { name: string; className?: string }) {
  return (
    <div
      className={cn(
        "bg-muted text-foreground grid size-[22px] shrink-0 place-items-center rounded-full text-[11.5px] font-semibold",
        className,
      )}
    >
      {name.trim()[0]?.toUpperCase() ?? "?"}
    </div>
  );
}

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

/**
 * WHERE A LINK GOES.
 *
 * The server stores what was typed, and what people type in a box marked
 * "GitHub" is a handle about as often as it is a URL. A full URL is used
 * exactly as given; anything else is hung off the site's own prefix, with a
 * leading @ dropped. A bare `example.com` in the website box gets https://
 * rather than being treated as a relative path, which is the one reading that
 * would take somebody to a page on this app.
 */
const SITES: { key: keyof WatchLinks; label: string; base: string }[] = [
  { key: "website", label: "Website", base: "" },
  { key: "github", label: "GitHub", base: "https://github.com/" },
  { key: "x", label: "X", base: "https://x.com/" },
  { key: "linkedin", label: "LinkedIn", base: "https://www.linkedin.com/in/" },
  { key: "bluesky", label: "Bluesky", base: "https://bsky.app/profile/" },
];

function href(value: string, base: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  return base ? base + v.replace(/^@/, "") : `https://${v}`;
}

/* ------------------------------------------------------------------ rail */

/**
 * THE PEOPLE, DOWN THE SIDE, INSTEAD OF THE RUNS.
 *
 * The other workers' rail lists what the worker has done, because on those
 * pages a run is the unit somebody navigates by. Here it is not: the owner
 * thinks "what do we know about Jane", and the three dossiers on Jane are the
 * answer to that question rather than three separate things to find. So this
 * rail lists the names and the transcript narrows to whoever is picked.
 *
 * "EVERYONE" IS A ROW AND NOT AN X. It is the state the page opens in, it is
 * where the cards are, and a rail whose only way back was deselecting the
 * current row would be a rail with a mode nobody can see.
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
    <aside className="bg-sidebar border-line-soft hidden w-[264px] shrink-0 flex-col border-r lg:flex">
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
              <Tile name={p.name} className="size-[22px]" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[13.5px]">{p.name}</span>
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

/** WHO IS OPEN, at the top of their own transcript. The links are chips rather
 *  than a paragraph of URLs: they are things to open, and they open away from
 *  this app, which is what the new tab says. */
export function PersonHeader({
  person,
  onEdit,
  onRemove,
  removing,
}: {
  person: WatchPerson;
  onEdit: () => void;
  onRemove: () => void;
  removing: boolean;
}) {
  /* TWO PRESSES, because one press deletes something the owner typed. The
     confirm is the button itself changing its mind rather than a dialog: the
     thing being confirmed stays on screen behind it. It resets when the header
     is keyed to a new person rather than in an effect — see the call site. */
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const t = setTimeout(() => setSure(false), 4000);
    return () => clearTimeout(t);
  }, [sure]);

  const line = [said(person.role), said(person.company)].filter(Boolean).join(" · ");
  const links = SITES.map((site) => ({
    ...site,
    url: href(said(person.links?.[site.key]), site.base),
  })).filter((l) => l.url);

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-start gap-3">
        <Tile name={person.name} className="mt-0.5 size-[34px] text-[14px]" />
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-[20px] font-normal tracking-[-0.02em]">
            {person.name}
            <span className={cn("size-1.5 shrink-0 rounded-full", tone(person))} />
          </h1>
          <p className="text-muted-foreground text-[13.5px]">
            {line || said(person.email) || "Nothing said about them yet."}
          </p>
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

      {(links.length > 0 || said(person.email) || said(person.note)) && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {said(person.email) && line && (
            <a
              href={`mailto:${said(person.email)}`}
              className="bg-card hover:bg-card-hover rounded-full px-2.5 py-1 text-[12.5px] transition-colors"
            >
              {said(person.email)}
            </a>
          )}
          {links.map((l) => (
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
        </div>
      )}

      {said(person.note) && (
        <p className="text-muted-foreground mt-3 text-[13.5px] whitespace-pre-wrap">
          {said(person.note)}
        </p>
      )}

      {/* A COUNT THE PAGE CANNOT DERIVE. The transcript below is the last
          twenty runs narrowed to this person; the file may be thicker than
          that, and the server is the only thing that knows. */}
      <p className="text-muted-foreground mt-3 text-[12.5px]">
        {fileLine(person)}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------- the cards */

/**
 * EVERYONE, AS CARDS, with the way to add one as the last of them.
 *
 * The add tile is part of the grid rather than a button in a toolbar for the
 * Ventures page's reason: the list and the way to grow it are the same
 * gesture, and on an empty grid the dashed tile IS the empty state.
 */
export function PersonGrid({
  people,
  busy,
  onOpen,
  onWrite,
  onAdd,
}: {
  people: WatchPerson[];
  /** Ids with a dossier being asked for right now — the button's own state,
   *  which is not the same as the server's `running`: it covers the second
   *  between the press and the answer. */
  busy: Set<string>;
  onOpen: (id: string) => void;
  onWrite: (person: WatchPerson) => void;
  onAdd: () => void;
}) {
  return (
    <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
      {people.map((p) => {
        const flight = p.dossiers.running || p.dossiers.queued > 0 || busy.has(p.id);
        return (
          <div
            key={p.id}
            className="bg-card flex min-h-[132px] flex-col rounded-[14px] p-4"
          >
            <button
              onClick={() => onOpen(p.id)}
              className="flex items-start gap-2.5 text-left"
            >
              <Tile name={p.name} className="mt-0.5 size-[26px] text-[12px]" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
                    {p.name}
                  </span>
                  <span className={cn("size-1.5 shrink-0 rounded-full", tone(p))} />
                </span>
                <span className="text-muted-foreground block truncate text-[12.5px]">
                  {[said(p.role), said(p.company)].filter(Boolean).join(" · ") ||
                    said(p.email) ||
                    "no role or company on file"}
                </span>
              </span>
            </button>

            <p className="text-muted-foreground mt-3 text-[12.5px]">{fileLine(p)}</p>

            <div className="mt-auto pt-3">
              <Button
                size="sm"
                variant="outline"
                disabled={flight}
                onClick={() => onWrite(p)}
              >
                {flight
                  ? p.dossiers.queued > 0 && !p.dossiers.running
                    ? "Queued…"
                    : "Writing…"
                  : p.dossiers.count > 0
                    ? "Write another"
                    : "Write a dossier"}
              </Button>
            </div>
          </div>
        );
      })}

      <button
        onClick={onAdd}
        className="text-muted-foreground hover:border-line-strong hover:text-foreground flex min-h-[132px] flex-col items-center justify-center gap-2 rounded-[14px] border border-dashed transition-colors"
      >
        <Plus className="size-[18px]" strokeWidth={1.6} />
        <span className="text-[14px]">Add person</span>
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- the form */

/**
 * THE ONE FORM, FOR ADDING AND FOR EDITING.
 *
 * A CARD RATHER THAN A DIALOG, and that is not a styling preference: a dialog
 * over this page would cover the list the owner is adding to, and the thing
 * they most often want while typing a name is to see whether it is already
 * there. It sits where the cards are and pushes them down.
 *
 * THE SERVER'S 409 IS SHOWN WHERE IT HAPPENED. A duplicate name is a real
 * answer — somebody is already on the list — and it belongs under the name box
 * rather than in a toast that has gone by the time the owner looks up.
 */
export function PersonForm({
  person,
  saving,
  problem,
  onCancel,
  onSave,
}: {
  /** The person being edited, or null for a new one. */
  person: WatchPerson | null;
  saving: boolean;
  problem: string | null;
  /** NULL WHEN THERE IS NOTHING TO GO BACK TO — an empty watchlist, where the
   *  form is the page. A Cancel button that shuts nothing is worse than no
   *  Cancel button, so it is not drawn rather than drawn dead. */
  onCancel: (() => void) | null;
  onSave: (input: WatchInput) => void;
}) {
  const [form, setForm] = useState<Required<Omit<WatchInput, "links">> & { links: Record<string, string> }>(() => ({
    name: person?.name ?? "",
    role: said(person?.role),
    company: said(person?.company),
    email: said(person?.email),
    note: said(person?.note),
    links: Object.fromEntries(SITES.map((s) => [s.key, said(person?.links?.[s.key])])),
  }));

  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const named = form.name.trim().length > 0;

  return (
    <section className="bg-card mb-5 rounded-[14px] p-4.5">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-[14px] font-medium">
          {person ? `Edit ${person.name}` : "Add a person of interest"}
        </h2>
        {onCancel && (
          <button
            onClick={onCancel}
            aria-label="Close the form"
            className="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto rounded-lg p-1.5"
          >
            <X className="size-3.5" strokeWidth={1.6} />
          </button>
        )}
      </div>

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

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {SITES.map((site) => (
          <label key={site.key} className="flex flex-col gap-1">
            <span className="text-muted-foreground text-[12.5px]">{site.label}</span>
            <Input
              value={form.links[site.key] ?? ""}
              onChange={(e) => set({ links: { ...form.links, [site.key]: e.target.value } })}
              placeholder={site.base ? `${site.base}handle` : "https://example.com"}
            />
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

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          disabled={!named || saving}
          onClick={() =>
            onSave({
              name: form.name.trim(),
              role: form.role.trim(),
              company: form.company.trim(),
              email: form.email.trim(),
              note: form.note,
              links: Object.fromEntries(
                SITES.map((s) => [s.key, (form.links[s.key] ?? "").trim()]),
              ) as WatchLinks,
            })
          }
        >
          {saving ? "Saving…" : person ? "Save" : "Add"}
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        )}
      </div>
    </section>
  );
}
