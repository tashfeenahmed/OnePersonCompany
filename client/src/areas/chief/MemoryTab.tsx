import { useState } from "react";
import { Loader2, Pencil, Trash2, Undo2, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/hooks/useApi";
import { memoryApi, type MemoryNote } from "@/lib/api/chief";

/**
 * WHAT THE ASSISTANT KNOWS, WITH THE OWNER'S HAND ON IT.
 *
 * EVERY ROW SAYS WHO BELIEVED IT AND WHEN. That is the whole design: a note is
 * a dated belief and not a fact, so "I noticed" and "you told me" are drawn
 * differently and both carry an age. A list of bare sentences would read as a
 * set of facts about the owner, which is exactly the thing that becomes
 * confidently wrong four months later.
 *
 * EDITING A NOTE MAKES IT THE OWNER'S. The server stamps `source: owner` on
 * every edit from here, and an owner note is permanently out of the weekly
 * consolidation pass's reach. So correcting the assistant is not a suggestion
 * to it — it is the end of the argument.
 *
 * CONSOLIDATE AND UNDO SIT TOGETHER, deliberately. The pass asks a model to
 * merge and drop; the button beside it puts the whole set back. Showing the
 * destructive one without its reverse is how a person learns not to press
 * either.
 */
export function MemoryTab() {
  const doc = useApi(() => memoryApi.all(), []);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const run = (what: string, p: Promise<unknown>) => {
    setBusy(what);
    setFailure(null);
    setSaid(null);
    p.then((out) => {
      const o = out as { note?: string; why?: string | null; merged?: number; dropped?: number; restored?: number };
      if (typeof o.restored === "number") setSaid(`Put back ${o.restored} notes.`);
      else if (typeof o.merged === "number")
        setSaid(o.why ?? `Merged ${o.merged}, dropped ${o.dropped}.`);
    })
      .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(null);
        doc.reload();
      });
  };

  if (doc.error) return <p className="text-destructive text-[13.5px]">{doc.error}</p>;
  if (!doc.data)
    return <p className="text-muted-foreground text-[13.5px]">Reading the memory…</p>;

  const { notes, total, limits, passes, canUndo } = doc.data;
  const lastPass = passes[0] ?? null;

  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground text-[12.5px]">
        The newest {limits.injectedIntoChat} relevant notes go into the agent's
        system turn on every conversation; the rest are counted for it rather
        than hidden. This is the dashboard's own memory, shared by whichever
        backend is answering — a managed Hermes keeps its own MEMORY.md as well,
        and that one goes with the agent.
      </p>

      {/* ------------------------------------------------------------ write */}
      <div className="border-line-soft bg-card rounded-[10px] border p-4">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Something durable: a decision, a constraint, a thing that turned out not to work. Not a figure — those go stale."
          className="text-[13px]"
        />
        <div className="mt-2 flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !text.trim()}
            onClick={() => {
              run("add", memoryApi.add(text.trim()));
              setText("");
            }}
          >
            Remember this
          </Button>
          <span className="text-muted-foreground text-[11.5px]">
            {total} note{total === 1 ? "" : "s"}, cap {limits.maxNotes}
          </span>
        </div>
      </div>

      {/* -------------------------------------------------------- the passes */}
      <div className="border-line-soft bg-card flex flex-wrap items-center gap-2 rounded-[10px] border p-3">
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => run("consolidate", memoryApi.consolidate(true))}
        >
          {busy === "consolidate" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Wand2 className="size-3.5" strokeWidth={1.6} />
          )}
          Consolidate now
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null || !canUndo}
          onClick={() => run("undo", memoryApi.undo())}
        >
          <Undo2 className="size-3.5" strokeWidth={1.6} />
          Undo the last pass
        </Button>
        <span className="text-muted-foreground text-[11.5px]">
          {lastPass
            ? `Last pass ${lastPass.week}: ${lastPass.notes_before} → ${lastPass.notes_after} notes` +
              (lastPass.error ? ` — ${lastPass.error}` : "")
            : "No pass has run yet. One runs automatically each week."}
        </span>
      </div>

      {said && <p className="text-muted-foreground text-[12.5px]">{said}</p>}
      {failure && <p className="text-destructive text-[12.5px]">{failure}</p>}

      {/* --------------------------------------------------------- the notes */}
      {notes.length === 0 ? (
        <p className="text-muted-foreground text-[13.5px]">
          Nothing is remembered yet. The agent writes here through the{" "}
          <code className="text-[12px]">memory</code> skill as it learns things;
          you can type one above.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {notes.map((n) => (
            <NoteRow
              key={n.id}
              note={n}
              busy={busy !== null}
              onSave={(t) => run(`edit-${n.id}`, memoryApi.edit(n.id, { text: t }))}
              onDelete={() => run(`del-${n.id}`, memoryApi.remove(n.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function NoteRow({
  note,
  busy,
  onSave,
  onDelete,
}: {
  note: MemoryNote;
  busy: boolean;
  onSave: (text: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(note.text);

  return (
    <div className="border-line-soft bg-card rounded-[10px] border px-3 py-2.5">
      {editing ? (
        <>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            className="text-[13px]"
          />
          <div className="mt-2 flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !text.trim()}
              onClick={() => {
                onSave(text.trim());
                setEditing(false);
              }}
            >
              Save — this becomes your note
            </Button>
            <Button size="xs" variant="ghost" onClick={() => (setText(note.text), setEditing(false))}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] leading-snug">{note.text}</p>
            <p className="text-muted-foreground mt-1 text-[11.5px]">
              {/* THE PROVENANCE AND THE AGE, ALWAYS. Without them this is a
                  list of assertions about the owner. */}
              {note.source === "owner" ? "You told it" : "It noticed"} ·{" "}
              {note.ageDays === 0
                ? "confirmed today"
                : note.ageDays === 1
                  ? "confirmed yesterday"
                  : `confirmed ${note.ageDays} days ago`}
              {note.ventureName && ` · ${note.ventureName}`}
              {note.scope === "venture" && !note.ventureName && " · venture since deleted"}
            </p>
          </div>
          <Button size="icon-sm" variant="ghost" disabled={busy} onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" strokeWidth={1.6} />
          </Button>
          <Button size="icon-sm" variant="ghost" disabled={busy} onClick={onDelete}>
            <Trash2 className="size-3.5" strokeWidth={1.6} />
          </Button>
        </div>
      )}
    </div>
  );
}
