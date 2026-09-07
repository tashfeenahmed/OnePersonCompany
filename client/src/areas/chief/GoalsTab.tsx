import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/hooks/useApi";
import { goalsApi, type GoalDoc } from "@/lib/api/chief";

/**
 * THE GOALS EDITOR — two kinds of box and nothing else.
 *
 * ONE TEXTAREA PER SCOPE, NOT A FORM. A goal is a paragraph the owner thinks
 * in; the moment it becomes a title, a metric, a target and a due date it stops
 * being written and starts being maintained, and an unmaintained structured
 * goal is worse than a blank box — it is a stale intention the assistant is
 * faithfully steering by.
 *
 * SAVED EXPLICITLY, NOT ON BLUR. Every keystroke here goes into a system turn
 * on the next conversation, and an autosave that fired mid-sentence would put
 * half a thought in front of the agent. The button says what it has done and
 * when it last did it.
 *
 * `tailorTo` IS DRAWN AS A QUOTE FROM THE BOX AND NOT AS A FIELD. It is derived
 * from the stage the owner chose on the venture form; showing it in an editable
 * box would invite them to type over a sentence that is not theirs and would
 * come back next reload.
 */
export function GoalsTab() {
  const doc = useApi(() => goalsApi.all(), []);

  if (doc.error)
    return <p className="text-destructive text-[14.5px]">{doc.error}</p>;
  if (!doc.data)
    return <p className="text-muted-foreground text-[14.5px]">Reading the goals…</p>;

  const { global, ventures, summary } = doc.data;

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground text-[13.5px]">
        These go into the agent's system turn on every conversation — the
        workspace goals always, a venture's when the chat is filed under it. The
        agent is told not to rewrite them unasked.{" "}
        {summary.blank > 0 && (
          <>
            {summary.written} of {ventures.length} ventures have goals written.
          </>
        )}
      </p>

      {/* KEYED ON WHAT THE SERVER LAST SAID. A save elsewhere on this page
          re-reads the whole document, and a box the owner has typed into must
          not be silently overwritten by that — but a document that has genuinely
          changed underneath must not be shown stale either. Remounting on the
          server's own timestamp is the React way to say "this is a different
          document now", and it is why there is no effect syncing props into
          state below. */}
      <Editor
        key={global.updatedAt ?? "blank"}
        label="The whole business"
        hint="What you are doing with the estate. One or two paragraphs; markdown is fine."
        doc={global}
        onSave={(text) => goalsApi.setGlobal(text)}
      />

      <div className="flex flex-col gap-4">
        <h2 className="text-[16px] font-medium">Per venture</h2>
        {ventures.map((v) => (
          <Editor
            key={`${v.ventureId}:${v.updatedAt ?? "blank"}`}
            label={v.ventureName ?? v.ventureSlug ?? "Venture"}
            hint={v.tailorTo ? `Advice here is tailored to: ${v.tailorTo}` : undefined}
            doc={v}
            onSave={(text) => goalsApi.setVenture(v.ventureSlug ?? v.ventureId!, text)}
          />
        ))}
      </div>
    </div>
  );
}

function Editor({
  label,
  hint,
  doc,
  onSave,
}: {
  label: string;
  hint?: string;
  doc: GoalDoc;
  onSave: (text: string) => Promise<GoalDoc>;
}) {
  const [text, setText] = useState(doc.text);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(doc.updatedAt);
  const [failure, setFailure] = useState<string | null>(null);

  const changed = text.trim() !== doc.text.trim();

  return (
    <div className="border-line-soft bg-card rounded-[14px] p-5">
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[14.5px] font-medium">{label}</span>
        <span className="text-muted-foreground ml-auto text-[12.5px]">
          {/* Null is a real state — nothing has ever been written — and says so
              rather than showing a date of nothing. */}
          {savedAt ? `edited ${savedAt.slice(0, 10)}` : "never written"}
        </span>
      </div>
      {hint && (
        <p className="text-muted-foreground mb-2 text-[12.5px] leading-snug">{hint}</p>
      )}
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={text.length > 200 ? 8 : 4}
        placeholder="Nothing written. What are you actually trying to do here?"
        className="text-[14px]"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={saving || !changed}
          onClick={() => {
            setSaving(true);
            setFailure(null);
            onSave(text.trim())
              .then((d) => {
                setSavedAt(d.updatedAt);
                setText(d.text);
              })
              .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
              .finally(() => setSaving(false));
          }}
        >
          {saving && <Loader2 className="size-3.5 animate-spin" />}
          {changed ? "Save" : "Saved"}
        </Button>
        {failure && <span className="text-destructive text-[12.5px]">{failure}</span>}
      </div>
    </div>
  );
}
