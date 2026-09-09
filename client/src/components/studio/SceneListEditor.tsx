import { useMemo, useState } from "react";
import { Loader2, Play, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/hooks/useApi";
import { cn } from "@/lib/utils";
import { motionApi, type MotionReadiness, type PreviewDoc, type SpecDetail } from "@/lib/api/motion";

/**
 * THE SCENE-SPEC EDITOR — the one place in this app where the owner writes the
 * video rather than describing it.
 *
 * It was a page of its own beside the Studio, which meant "make a motion
 * video" was two screens: one to pick a scene list and one to write it. It is
 * a component now, drawn UNDER the Studio's Motion picker the moment a saved
 * list is chosen, and the button that renders it is the composer's own — so
 * choosing, editing and making are one screen and one press.
 *
 * A JSON BOX AND A FORM, NOT ONE OR THE OTHER. The spec is a small structured
 * document and the honest way to show it is as itself: five scene kinds with
 * different fields, which any form general enough to hold all of them would
 * flatten into a wall of empty inputs. So the JSON is the document and the form
 * beside it covers only the fields EVERY scene has — its kind, how long it
 * holds, its kicker, and the line a narrator would read. Those four are the
 * ones somebody adjusts ten times while getting the pacing right, and clicking
 * into a text area to change `3.2` to `4` ten times is how a good tool becomes
 * an annoying one.
 *
 * THE FORM WRITES BACK INTO THE JSON RATHER THAN INTO A SECOND STATE. There is
 * one source of truth here — the text in the box — and the form parses it,
 * changes one field and re-serialises. That is slightly more work per keystroke
 * and it makes the two halves incapable of disagreeing, which is the failure
 * mode of every "form and raw view" editor that keeps them apart.
 *
 * `problems` IS DRAWN AS PROMINENTLY AS AN ERROR AND IS NOT ONE. The server
 * clamps rather than argues: a heading too long is cut, a nine-item list
 * becomes six, a scene too long becomes the ceiling. Those changes come back
 * with the saved spec and they are the difference between a tool that did what
 * you asked and one that did something near it.
 *
 * THE PREVIEW IS THE REAL RENDERER. One browser launch draws the first frame
 * of every scene at a third of the size — the same CSS, the same fonts, the
 * same colours as the video. It is not a mock-up of what the video might look
 * like, and it takes a few seconds, which is why it is a button rather than
 * something that happens on every keystroke.
 *
 * THERE IS NO RENDER BUTTON HERE, ON PURPOSE. Rendering is a queued `video`
 * run, and in the Studio every tab starts its run from the one button at the
 * bottom of the composer. A second Render inside the editor would be a second
 * way to spend the same machine, three inches above the first.
 */

/** What a hand-written spec starts as: one of each of the three kinds somebody
 *  actually opens with, so "New" lands on something editable rather than on an
 *  empty array and a schema to look up. */
const EXAMPLE = {
  title: "A new scene list",
  scenes: [
    { kind: "title", kicker: "Introducing", title: "Write the line here", subtitle: "And a shorter one under it", seconds: 3.2, say: "" },
    { kind: "list", heading: "What it does", items: ["The first thing", "The second thing", "The third thing"], seconds: 5, say: "" },
    { kind: "cta", headline: "Have a look", action: "Start free", url: null, seconds: 3, say: "" },
  ],
};

/** Writes the example above and hands back its id, so the caller can select it
 *  and drop straight into the editor. The one way to create a spec by hand. */
export function NewSceneListButton({ ventureId, onCreated }: { ventureId: string | null; onCreated: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  return (
    <>
      <Button
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setRefused(null);
          motionApi
            .create({ name: "New scene list", venture: ventureId, spec: EXAMPLE })
            .then((r) => onCreated(r.id))
            .catch((err: unknown) => setRefused(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} /> : <Sparkles className="size-[14px]" strokeWidth={1.8} />}
        New, from the example
      </Button>
      {refused && <span className="text-destructive text-[12.5px]">{refused}</span>}
    </>
  );
}

/**
 * WHAT THIS MACHINE CAN DO WITH A SCENE LIST, SAID ONLY WHEN IT CANNOT.
 *
 * The Motion page listed all three capabilities always. In a composer the
 * normal case — a browser, ffmpeg and a model provider all present — is three
 * green lines above a field nobody needed to read; the state worth the space
 * is the missing one, which is the difference between a button that works and
 * one that queues a run to fail.
 */
export function MotionReadinessNote({ readiness }: { readiness: MotionReadiness }) {
  const missing = [
    { key: "renderer", label: "Renderer", ...readiness.renderer },
    { key: "encoder", label: "Encoder", ...readiness.encoder },
    { key: "writer", label: "Scene writer", ...readiness.writer },
  ].filter((c) => !c.ready);
  if (!missing.length) return null;
  return (
    <div className="grid gap-1 text-[12.5px]">
      {missing.map((c) => (
        <div key={c.key} className="flex gap-2">
          <span className="bg-warn mt-[6px] size-[7px] shrink-0 rounded-full" />
          <span className="w-[86px] shrink-0">{c.label}</span>
          <span className="text-muted-foreground">{c.note}</span>
        </div>
      ))}
    </div>
  );
}

/** A rough wall-clock estimate, in the words a person would use. Never "1
 *  minutes", and never a decimal for something this approximate. */
function minutes(seconds: number): string {
  if (seconds < 90) return `about ${Math.max(10, Math.round(seconds / 10) * 10)} seconds`;
  const m = Math.round(seconds / 60);
  return `about ${m} minute${m === 1 ? "" : "s"}`;
}

export function SceneListEditor({ id, onChanged, onDeleted, className }: {
  id: string;
  /** A save landed: whatever lists these specs should re-read their names,
   *  scene counts and lengths. */
  onChanged: () => void;
  /** The spec is gone. The picker above must stop naming it. */
  onDeleted: () => void;
  className?: string;
}) {
  const doc = useApi(() => motionApi.get(id), [id]);
  const [text, setText] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewDoc | null>(null);

  const detail: SpecDetail | null = doc.data;
  const body = text ?? (detail?.spec ? JSON.stringify(detail.spec, null, 2) : "");

  /* The parsed document, or null while it is mid-edit and not valid JSON. The
     per-scene form is hidden in that state rather than throwing away the
     owner's half-typed text. */
  const parsed = useMemo(() => {
    try {
      const v = JSON.parse(body) as { scenes?: unknown[] };
      return Array.isArray(v.scenes) ? v : null;
    } catch {
      return null;
    }
  }, [body]);

  function patchScene(index: number, key: string, value: unknown) {
    if (!parsed) return;
    const next = structuredClone(parsed) as { scenes: Record<string, unknown>[] };
    next.scenes[index] = { ...next.scenes[index], [key]: value };
    setText(JSON.stringify(next, null, 2));
  }

  if (doc.error) return <p className="text-destructive text-[13.5px]">{doc.error}</p>;
  if (!detail) return <p className="text-muted-foreground text-[13.5px]">Reading the scene list…</p>;
  if (!detail.readable)
    return <p className="text-destructive text-[13.5px]">This spec is no longer readable as a scene list.</p>;

  return (
    <div className={cn("border-line-soft grid gap-3 border-t pt-3.5", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={name ?? detail.name}
          onChange={(e) => setName(e.target.value)}
          className="border-line-soft rounded-[11px] border bg-transparent px-2.5 py-1.5 text-[14px]"
        />
        {detail.cost && (
          <span className="text-muted-foreground text-[12.5px]">
            {detail.cost.frames} frames at {detail.cost.fps}/s · {detail.cost.sheets} browser launches,{" "}
            {/* A BROWSER LAUNCH IS ABOUT TWO AND A HALF SECONDS ON THIS
                MACHINE, measured. It is shown as a rough time because "24
                browser launches" is not a unit anybody plans around, and it is
                said as "about" because the encode and the model are on top. */}
            {minutes(detail.cost.sheets * 2.6)} of this machine
          </span>
        )}
      </div>

      {/* --------------------------------------------- the per-scene form */}
      {parsed ? (
        <div className="grid gap-1.5">
          <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">The scenes</div>
          {(parsed.scenes as Record<string, unknown>[]).map((scene, i) => (
            <div key={i} className="border-line-soft flex flex-wrap items-center gap-2 border-l-2 py-1 pl-2.5">
              <span className="text-muted-foreground w-[18px] text-[12.5px]">{i + 1}</span>
              <select
                value={String(scene.kind ?? "")}
                onChange={(e) => patchScene(i, "kind", e.target.value)}
                className="border-line-soft rounded-[11px] border bg-transparent px-2 py-1 text-[13px]"
              >
                {["title", "stat", "compare", "list", "cta"].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <label className="text-muted-foreground flex items-center gap-1 text-[12.5px]">
                seconds
                <input
                  type="number"
                  step="0.1"
                  value={typeof scene.seconds === "number" ? scene.seconds : ""}
                  onChange={(e) => patchScene(i, "seconds", Number(e.target.value))}
                  className="border-line-soft w-[62px] rounded-[11px] border bg-transparent px-1.5 py-1 text-[13px]"
                />
              </label>
              <input
                value={typeof scene.kicker === "string" ? scene.kicker : ""}
                onChange={(e) => patchScene(i, "kicker", e.target.value)}
                placeholder="kicker"
                className="border-line-soft w-[130px] rounded-[11px] border bg-transparent px-2 py-1 text-[13px]"
              />
              <input
                value={typeof scene.say === "string" ? scene.say : ""}
                onChange={(e) => patchScene(i, "say", e.target.value)}
                placeholder="what a narrator would read"
                className="border-line-soft min-w-[180px] flex-1 rounded-[11px] border bg-transparent px-2 py-1 text-[13px]"
              />
            </div>
          ))}
        </div>
      ) : (
        <p className="text-warn text-[13px]">
          The JSON below is not currently valid, so the per-scene fields are hidden rather than
          rewriting what you are typing.
        </p>
      )}

      {/* ------------------------------------------------------- the JSON */}
      <textarea
        value={body}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        rows={14}
        className="border-line-soft rounded-[11px] border bg-transparent px-2.5 py-2 font-mono text-[12.5px] leading-[1.5]"
      />

      {!!problems.length && (
        <div className="border-line-soft grid gap-1 border-l-2 pl-2.5 text-[13px]">
          <span className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
            What was changed on the way in
          </span>
          {problems.map((p, i) => (
            <span key={i} className="text-muted-foreground">
              {p}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => {
            setBusy("save");
            setSaid(null);
            let raw: unknown;
            try {
              raw = JSON.parse(body) as unknown;
            } catch (err) {
              setSaid(`That is not JSON: ${err instanceof Error ? err.message : String(err)}`);
              setBusy(null);
              return;
            }
            motionApi
              .update(id, { name: name ?? detail.name, spec: raw })
              .then((r) => {
                setProblems(r.problems);
                setSaid(r.problems.length ? "Saved — with the changes listed above." : "Saved.");
                setText(r.spec ? JSON.stringify(r.spec, null, 2) : body);
                doc.reload();
                onChanged();
              })
              .catch((err: unknown) => setSaid(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(null));
          }}
        >
          {busy === "save" ? <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} /> : null}
          Save
        </Button>

        <Button
          variant="outline"
          disabled={busy !== null}
          onClick={() => {
            setBusy("preview");
            setSaid(null);
            motionApi
              .preview(id)
              .then(setPreview)
              .catch((err: unknown) => setSaid(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(null));
          }}
        >
          {busy === "preview" ? <Loader2 className="size-[14px] animate-spin" strokeWidth={1.8} /> : <Play className="size-[14px]" strokeWidth={1.8} />}
          Preview the scenes
        </Button>

        <Button
          variant="ghost"
          disabled={busy !== null}
          onClick={() => {
            /* CONFIRMED, on the repo's own convention for anything that
               destroys something the owner typed. */
            if (!confirm(`Delete “${detail.name}”? The scene list and its preview frames go with it. A video already rendered from it keeps its own copy and is not affected.`))
              return;
            setBusy("delete");
            motionApi
              .remove(id)
              .then(onDeleted)
              .catch((err: unknown) => setSaid(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(null));
          }}
        >
          <Trash2 className="size-[14px]" strokeWidth={1.8} />
        </Button>
      </div>

      {said && <p className="text-[13px]">{said}</p>}

      {/* ---------------------------------------------------- the preview */}
      {preview && (
        <div className="grid gap-1.5">
          <div className="text-muted-foreground text-[12px] tracking-[0.06em] uppercase">
            The first frame of each scene
          </div>
          {preview.error && <p className="text-destructive text-[13px]">{preview.error}</p>}
          <div className="flex flex-wrap gap-2">
            {preview.frames.map((f) => (
              <div key={f.index} className="grid w-[128px] gap-1">
                {f.image ? (
                  <img
                    src={f.image}
                    alt={`Scene ${f.index}, ${f.kind}`}
                    className="border-line-soft w-full rounded-[8px] border bg-black"
                  />
                ) : (
                  <div className="border-line-soft text-muted-foreground grid h-[180px] place-items-center rounded-[8px] border px-1 text-center text-[11.5px]">
                    {f.error ?? "not drawn"}
                  </div>
                )}
                <span className="text-muted-foreground text-[12px]">
                  {f.index}. {f.kind} · {f.seconds}s
                </span>
              </div>
            ))}
          </div>
          <p className="text-muted-foreground text-[12.5px]">{preview.note}</p>
        </div>
      )}
    </div>
  );
}
