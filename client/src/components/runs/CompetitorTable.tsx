import { useState } from "react";
import { ChevronRight, CircleCheck, CircleDashed, Trash2 } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  isStale,
  recentChange,
  verifiedLabel,
  type ChangeLike,
} from "@/lib/competitors";
import {
  runsApi,
  type CompetitorFocus,
  type CompetitorProfile,
} from "@/lib/api/runs";
import type { Venture } from "@/lib/store";

/**
 * THE RIVALS, AS THE SWEEPS HAVE THEM SO FAR — AND WHAT MOVED.
 *
 * THIS TABLE IS THE POINT OF THE COMPETITORS APP, and the reports above it are
 * the working. Every other kind of run writes a document and stops; this one
 * ACCUMULATES — the second sweep verifies and deepens what the first found
 * rather than starting again, so what is worth looking at is the standing list
 * of who exists, not the transcript of the afternoon it was assembled.
 *
 * THE REGISTER IS CUMULATIVE AND THE BADGES ARE NOT. Who is in this market is
 * everything every sweep has ever verified: it has no window, and cutting it to
 * a fortnight would report three rivals for a market with eleven. What CHANGED
 * is news, and news expires — see `recentChange` for the window and why a badge
 * that never clears is a badge nobody reads. The full history stays one click
 * away under each row rather than being thrown out.
 *
 * `verified N days ago` IS THE COLUMN THAT MATTERS AND IT IS NOT A TIMESTAMP OF
 * THE LAST RUN. A sweep that does not mention a company leaves that company's
 * date alone: silence is not verification, and a table that stamped every row
 * with the date of the last sweep would claim eight confirmations for one. Past
 * six weeks it is drawn as a warning, because a rival several sweeps in a row
 * failed to find is a finding rather than a stale cell.
 *
 * THE COUNT IS DONE ON THE SERVER. `verifiedAgo` arrives already computed, so a
 * browser with a skewed clock or one that has just crossed midnight cannot
 * disagree with the box that recorded the date about how old a row is.
 *
 * THE TWO LISTS ABOVE THE TABLE ARE THE OTHER HALF OF THE MEMORY. "Last time"
 * is what the previous sweep said to look at, with what became of each item;
 * "Next time" is what this one is leaving behind. They are what make a sweep a
 * SERIES rather than a set of unrelated afternoons, and they are drawn above
 * the register because they are the part that changed since the owner last
 * looked — the register is mostly the same table it was yesterday.
 *
 * POSITIONING AND PRICING ARE EDITABLE IN PLACE; the name is not. The name is
 * the primary key the row is stored under, so renaming it here would not
 * correct a profile, it would fork one. What the owner can do is fix the two
 * fields a model is most likely to get slightly wrong, and delete a row that is
 * not a competitor at all.
 *
 * WHAT AN EDIT MEANS AFTERWARDS. A row the owner typed over keeps its date; the
 * next sweep may overwrite the text again, because the sweep is the thing that
 * knows what is true today. That is a real limitation and the alternative — an
 * owner-edited row the run may not touch — is a table that quietly stops being
 * updated, which is worse for the one thing it is for.
 */
export function CompetitorTable({
  venture,
  refreshKey,
}: {
  venture: Venture | null;
  /** The id of the run that just settled, or "" — see `RunApp`'s `extras`.
   *  It changes exactly once per finished sweep, which is when this table has
   *  something new to read, and never on the ticks while one is writing. */
  refreshKey: string;
}) {
  const doc = useApi(
    () =>
      venture ? runsApi.competitors(venture.id) : Promise.resolve(null),
    [venture?.id ?? null, refreshKey],
  );
  const [busy, setBusy] = useState<string | null>(null);

  if (!venture)
    return (
      <p className="text-muted-foreground text-[14px]">
        Pick a venture to see the rivals found for it.
      </p>
    );

  const profiles = doc.data?.profiles ?? [];
  const open = doc.data?.focus.open ?? [];
  const resolved = doc.data?.focus.resolved ?? [];

  /*
    BOTH WRITES SPLICE RATHER THAN REPLACE. The patch answers with the one
    profile as it now is and the delete answers with an acknowledgement, not
    with the document — so the alternative to splicing is a second GET after
    every keystroke that commits. `runs`, `lastRun` and `focus` are untouched by
    either of these (an owner's edit is not a sweep, and forgetting a rival does
    not unrun one), so nothing else on the document goes stale.
  */
  async function patch(
    name: string,
    field: "positioning" | "pricing",
    value: string,
  ) {
    if (!venture) return;
    setBusy(name + field);
    try {
      const saved = await runsApi.editCompetitor(venture.id, name, {
        [field]: value.trim() || null,
      });
      doc.setData((d) =>
        d
          ? {
              ...d,
              profiles: d.profiles.map((p) =>
                p.name === name ? saved : p,
              ),
            }
          : d,
      );
    } finally {
      setBusy(null);
    }
  }

  async function remove(profile: CompetitorProfile) {
    if (!venture) return;
    if (!confirm(`Forget ${profile.name}? The next sweep may find it again.`))
      return;
    setBusy(profile.name);
    try {
      await runsApi.removeCompetitor(venture.id, profile.name);
      doc.setData((d) =>
        d
          ? { ...d, profiles: d.profiles.filter((p) => p.name !== profile.name) }
          : d,
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {(resolved.length > 0 || open.length > 0) && (
        <div className="mb-4 grid gap-3 sm:grid-cols-2">
          {/* LAST TIME first, because it is the answer to a question the owner
              already had. A list of new questions reads as work; a list of
              answered ones reads as progress, and the sweep earned it. */}
          {resolved.length > 0 && (
            <FocusList
              title="Last time"
              hint="What the previous sweep said to look at, and what this one found."
              items={resolved}
              resolved
            />
          )}
          {open.length > 0 && (
            <FocusList
              title="Next time"
              /* SAYS WHY AN ITEM CAN APPEAR IN BOTH PANELS. Anything the last
                 sweep raised and this one did not settle is still open, so it
                 is in both — marked "not got to" on the left and waiting on
                 the right. Without the clause that reads as the same list
                 printed twice. */
              hint="Still open, including anything on the left this sweep did not settle. The next sweep is handed all of it."
              items={open}
            />
          )}
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
          Who else is in this market
        </div>
        <span className="text-muted-foreground ml-auto text-[12.5px]">
          {doc.loading && !doc.data
            ? "loading…"
            : doc.error
              ? doc.error
              : profiles.length === 0
                ? "nothing found yet"
                : `${profiles.length} ${profiles.length === 1 ? "rival" : "rivals"} · ${doc.data?.runs ?? 0} ${
                    (doc.data?.runs ?? 0) === 1 ? "sweep" : "sweeps"
                  }${doc.data?.lastRun ? `, last ${ago(doc.data.lastRun)}` : ""}`}
        </span>
      </div>

      {profiles.length === 0 ? (
        <p className="text-muted-foreground text-[14px]">
          {doc.error
            ? "The profiles could not be read."
            : `No rivals have been recorded for ${venture.name}. A sweep builds this list and the next one deepens it.`}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[14px] bg-card">
          <table className="w-full text-[13.5px]">
            <thead className="text-muted-foreground border-line-soft border-b text-[12px] tracking-[0.06em] uppercase">
              <tr>
                <th className="px-3 py-2 text-left font-normal">Name</th>
                <th className="px-3 py-2 text-left font-normal">Positioning</th>
                <th className="px-3 py-2 text-left font-normal">Pricing</th>
                <th className="px-3 py-2 text-right font-normal">Verified</th>
                <th className="px-3 py-2 text-right font-normal">First seen</th>
                <th className="w-8 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => (
                <Row
                  key={p.name}
                  profile={p}
                  busy={busy}
                  onPatch={patch}
                  onRemove={remove}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** One rival. Split out of the table because it holds the changes disclosure's
 *  own open/closed state, and a `useState` per row cannot live in a map inside
 *  the parent. */
function Row({
  profile: p,
  busy,
  onPatch,
  onRemove,
}: {
  profile: CompetitorProfile;
  busy: string | null;
  onPatch: (name: string, field: "positioning" | "pricing", value: string) => void;
  onRemove: (p: CompetitorProfile) => void;
}) {
  const [showChanges, setShowChanges] = useState(false);
  const recent = recentChange(p.changes);
  const stale = isStale(p.verifiedAgo);

  return (
    <tr
      className={cn(
        "border-line-soft border-t align-top",
        busy === p.name && "opacity-50",
      )}
    >
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {p.url ? (
            <a
              href={p.url}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              {p.name}
            </a>
          ) : (
            p.name
          )}
          {/* THE NOTE IS THE BADGE. It names what moved — "price moved, $14 →
              $19" — and it is written by the server at merge time, because it
              compares against a value this side never sees. The field name is
              the fallback for a change recorded before the notes existed. */}
          {recent && (
            <span
              title={`${recent.field} · ${ago(recent.at)}`}
              className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11.5px] whitespace-nowrap text-amber-700 dark:text-amber-400"
            >
              {recent.note || `${recent.field} changed`}
            </span>
          )}
        </div>
        {p.domain && (
          <div className="text-muted-foreground mt-0.5 font-mono text-[11px]">
            {p.domain}
          </div>
        )}
        {(p.strengths.length > 0 || p.weaknesses.length > 0) && (
          <div className="text-muted-foreground mt-0.5 text-[12.5px] leading-relaxed">
            {p.strengths.length > 0 && <div>Strong: {p.strengths.join(", ")}</div>}
            {p.weaknesses.length > 0 && <div>Weak: {p.weaknesses.join(", ")}</div>}
          </div>
        )}
        {/* THE HISTORY IS ONE CLICK AWAY RATHER THAN GONE. The badge above
            shows the newest movement while it is still news; everything the
            register has ever recorded about this rival is here, oldest first,
            which is the shape a story reads in. */}
        {p.changes.length > 0 && (
          <div className="mt-1">
            <button
              onClick={() => setShowChanges((v) => !v)}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[12px]"
            >
              <ChevronRight
                className={cn("size-3.5 transition-transform", showChanges && "rotate-90")}
                strokeWidth={1.6}
              />
              {p.changes.length} {p.changes.length === 1 ? "change" : "changes"}
            </button>
            {showChanges && (
              <ul className="text-muted-foreground mt-1 space-y-0.5 text-[12px] leading-relaxed">
                {p.changes.map((c: ChangeLike, i: number) => (
                  <li key={`${c.at}-${i}`}>
                    <span className="font-mono text-[11px]">{c.at.slice(0, 10)}</span>{" "}
                    {c.note || `${c.field} changed`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </td>
      <td className="px-3 py-2">
        <Cell
          value={p.positioning}
          busy={busy === p.name + "positioning"}
          onSave={(v) => onPatch(p.name, "positioning", v)}
        />
      </td>
      <td className="px-3 py-2">
        <Cell
          value={p.pricing}
          busy={busy === p.name + "pricing"}
          onSave={(v) => onPatch(p.name, "pricing", v)}
        />
      </td>
      <td
        className={cn(
          "px-3 py-2 text-right whitespace-nowrap",
          stale ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
        )}
        title={
          stale
            ? "No sweep has confirmed this one in over six weeks. Read what it says as what was true then, not as what is true now."
            : verifiedLabel(p.verifiedAgo)
        }
      >
        {ago(p.lastVerified)}
      </td>
      <td className="text-muted-foreground px-3 py-2 text-right whitespace-nowrap">
        {ago(p.firstSeen)}
      </td>
      <td className="px-2 py-2 text-right">
        <button
          onClick={() => onRemove(p)}
          title={`Forget ${p.name}`}
          className="text-muted-foreground hover:text-destructive rounded-md p-1"
        >
          <Trash2 className="size-3.5" strokeWidth={1.6} />
        </button>
      </td>
    </tr>
  );
}

/**
 * One of the two focus lists.
 *
 * THE TICK AND THE DASHED CIRCLE MEAN DIFFERENT THINGS AND BOTH ARE ANSWERS.
 * A ticked item was settled — the note says what was found, INCLUDING "we
 * looked and could not establish it", which is a finding and is why the item is
 * closed rather than asked again for the next three sweeps. A dashed one is a
 * question nothing has reached yet, and it stays open on purpose: the same rule
 * the verified dates follow, because silence is not an answer.
 */
function FocusList({
  title,
  hint,
  items,
  resolved,
}: {
  title: string;
  hint: string;
  items: CompetitorFocus[];
  resolved?: boolean;
}) {
  return (
    <div className="rounded-[14px] bg-card p-3">
      <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
        {title}
      </div>
      <p className="text-muted-foreground mt-0.5 text-[12px] leading-relaxed">
        {hint}
      </p>
      <ul className="mt-2 space-y-2">
        {items.map((f) => (
          <li key={f.id} className="flex gap-2">
            {resolved ? (
              f.done ? (
                <CircleCheck
                  className="mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
                  strokeWidth={1.8}
                />
              ) : (
                <CircleDashed
                  className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
                  strokeWidth={1.8}
                />
              )
            ) : (
              <CircleDashed
                className="text-muted-foreground mt-0.5 size-3.5 shrink-0"
                strokeWidth={1.8}
              />
            )}
            <div className="min-w-0">
              <div className="text-[13px] leading-snug">{f.title}</div>
              {(f.note ?? f.detail) && (
                <div className="text-muted-foreground mt-0.5 text-[12px] leading-relaxed">
                  {f.note ?? f.detail}
                </div>
              )}
              {resolved && !f.done && (
                <div className="text-muted-foreground mt-0.5 text-[12px] italic">
                  Not got to. It stays open.
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One editable cell: text until it is clicked, an input until it is left.
 *
 * NO SAVE BUTTON, because a table of two editable columns and eight rows would
 * grow sixteen of them. Escape abandons the edit and blur or Enter commits it,
 * which is the contract a spreadsheet already taught everybody. An unchanged
 * value does not write — a stray click should not stamp a row.
 */
function Cell({
  value,
  busy,
  onSave,
}: {
  value: string | null;
  busy: boolean;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");

  if (!editing)
    return (
      <button
        onClick={() => {
          setDraft(value ?? "");
          setEditing(true);
        }}
        disabled={busy}
        className={cn(
          "hover:bg-accent -mx-1 w-full rounded-md px-1 py-0.5 text-left leading-relaxed",
          !value && "text-muted-foreground",
        )}
      >
        {value || "not recorded"}
      </button>
    );

  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        setEditing(false);
        if (draft !== (value ?? "")) onSave(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(value ?? "");
          setEditing(false);
        }
      }}
      className="border-line-strong -mx-1 w-full rounded-md border bg-transparent px-1 py-0.5 text-[13.5px] outline-none"
    />
  );
}
