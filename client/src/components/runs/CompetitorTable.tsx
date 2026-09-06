import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { runsApi, type CompetitorProfile } from "@/lib/api/runs";
import type { Venture } from "@/lib/store";

/**
 * THE RIVALS, AS THE SWEEPS HAVE THEM SO FAR.
 *
 * THIS TABLE IS THE POINT OF THE COMPETITORS APP, and the reports above it are
 * the working. Every other kind of run writes a document and stops; this one
 * ACCUMULATES — the second sweep verifies and deepens what the first found
 * rather than starting again, so what is worth looking at is the standing list
 * of who exists, not the transcript of the afternoon it was assembled.
 *
 * `last verified` IS THE COLUMN THAT MATTERS AND IT IS NOT A TIMESTAMP OF THE
 * LAST RUN. A sweep that does not mention a company leaves that company's date
 * alone: silence is not verification, and a table that stamped every row with
 * the date of the last sweep would claim eight confirmations for one. A row
 * that has gone quiet for two months says two months, which is the finding.
 *
 * POSITIONING AND PRICING ARE EDITABLE IN PLACE; the name is not. The name is
 * the primary key the upsert matches on, so renaming a row here would not
 * correct a profile, it would fork one — the next sweep would find the old
 * name and write it back beside the edit. What the owner can do is fix the two
 * fields a model is most likely to get slightly wrong, and delete a row that
 * is not a competitor at all.
 *
 * WHAT AN EDIT MEANS AFTERWARDS. A row the owner typed over keeps its date;
 * the next sweep may overwrite the text again, because the sweep is the thing
 * that knows what is true today. That is a real limitation and the alternative
 * — an owner-edited row the run may not touch — is a table that quietly stops
 * being updated, which is worse for the one thing it is for.
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
      <p className="text-muted-foreground text-[13px]">
        Pick a venture to see the rivals found for it.
      </p>
    );

  const profiles = doc.data?.profiles ?? [];

  /*
    BOTH WRITES SPLICE RATHER THAN REPLACE. The patch answers with the one
    profile as it now is and the delete answers with an acknowledgement, not
    with the document — so the alternative to splicing is a second GET after
    every keystroke that commits. `runs` and `lastRun` are untouched by either
    of these (an owner's edit is not a sweep, and forgetting a rival does not
    unrun one), so nothing else on the document goes stale.
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
      <div className="mb-3 flex flex-wrap items-baseline gap-2">
        <div className="text-muted-foreground text-[11px] tracking-[0.06em] uppercase">
          Who else is in this market
        </div>
        <span className="text-muted-foreground ml-auto text-[11.5px]">
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
        <p className="text-muted-foreground text-[13px]">
          {doc.error
            ? "The profiles could not be read."
            : `No rivals have been recorded for ${venture.name}. A sweep builds this list and the next one deepens it.`}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-[10px] border">
          <table className="w-full text-[12.5px]">
            <thead className="text-muted-foreground border-line-soft border-b text-[11px] tracking-[0.06em] uppercase">
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
                <tr
                  key={p.name}
                  className={cn(
                    "border-line-soft border-t align-top",
                    busy === p.name && "opacity-50",
                  )}
                >
                  <td className="px-3 py-2">
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
                    {(p.strengths.length > 0 || p.weaknesses.length > 0) && (
                      <div className="text-muted-foreground mt-0.5 text-[11.5px] leading-relaxed">
                        {p.strengths.length > 0 && (
                          <div>Strong: {p.strengths.join(", ")}</div>
                        )}
                        {p.weaknesses.length > 0 && (
                          <div>Weak: {p.weaknesses.join(", ")}</div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Cell
                      value={p.positioning}
                      busy={busy === p.name + "positioning"}
                      onSave={(v) => void patch(p.name, "positioning", v)}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <Cell
                      value={p.pricing}
                      busy={busy === p.name + "pricing"}
                      onSave={(v) => void patch(p.name, "pricing", v)}
                    />
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-right whitespace-nowrap">
                    {ago(p.lastVerified)}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-right whitespace-nowrap">
                    {ago(p.firstSeen)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => void remove(p)}
                      title={`Forget ${p.name}`}
                      className="text-muted-foreground hover:text-destructive rounded-md p-1"
                    >
                      <Trash2 className="size-3.5" strokeWidth={1.6} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
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
      className="border-line-strong -mx-1 w-full rounded-md border bg-transparent px-1 py-0.5 text-[12.5px] outline-none"
    />
  );
}
